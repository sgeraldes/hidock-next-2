#!/usr/bin/env python3
"""
Backup en caliente de la base de HiDock, con rotacion.

Por que no es un `copy`: la base corre en modo WAL con la app abierta. Copiar el
archivo mientras hay escrituras en vuelo produce una base con paginas de dos
transacciones distintas — se abre, parece sana, y falla mucho despues. La API de
backup de SQLite (`Connection.backup`) toma un snapshot consistente sin frenar
a la app, y no necesita que HiDock este cerrado.

El backup se escribe primero a un `.tmp` y recien al terminar se renombra al
nombre final. Un corte de luz a mitad deja un `.tmp` incompleto, nunca un
backup con nombre bueno y contenido malo.

Retencion por defecto: 24 horarios + 14 diarios + 8 semanales. Cada backup pesa
lo que la base (~2,7 GB hoy), asi que el tope real lo fija el disco; con esa
retencion son ~125 GB contra los 2.768 GB libres en F:.

Uso:
    python backup-db.py                  # backup + rotacion
    python backup-db.py --verify-only    # verifica los backups existentes
    python backup-db.py --dry-run        # dice que haria, no toca nada
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

if sys.platform == "win32":
    # getattr: sys.stdout no siempre es un TextIOWrapper (pytest, pipes raros).
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure is not None:
        reconfigure(encoding="utf-8")

DB = Path(r"F:\HiDock-Next-Data\data\hidock.db")
BACKUP_DIR = Path(r"F:\HiDock-Next-Data\backups")

KEEP_HOURLY = 24
KEEP_DAILY = 14
KEEP_WEEKLY = 8

PREFIX = "hidock-"
SUFFIX = ".db"
STAMP = "%Y%m%d-%H%M%S"


def now_local() -> datetime:
    """Hora local CON zona. Los nombres de backup llevan la hora del reloj de
    esta maquina, que es la que uno lee en el explorador; la zona explicita es
    para que la aritmetica de retencion no mezcle naive y aware."""
    return datetime.now().astimezone()


def log(msg: str) -> None:
    print(f"[{now_local():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def sweep_stale_temps(older_than_hours: int = 6) -> None:
    """Barre los `.tmp` (y sus sidecars) que dejo una corrida interrumpida.

    Una corrida cortada a mitad deja un `.tmp` de varios GB. Sin esto se
    acumulan de a uno por corte hasta llenar el disco. Solo se tocan archivos
    con el prefijo de este script, mas viejos que el umbral para no pisar un
    backup en curso, y se borran por ruta literal.
    """
    cutoff = time.time() - older_than_hours * 3600
    for path in list(BACKUP_DIR.iterdir()):
        name = path.name
        if not name.startswith(PREFIX):
            continue
        if ".tmp" not in name:
            continue
        try:
            if path.stat().st_mtime > cutoff:
                continue
            os.remove(str(path))
            log(f"barrido temporal viejo: {name}")
        except OSError as e:
            log(f"no pude barrer {name}: {e}")


def backup_once(dry_run: bool = False) -> Path | None:
    if not DB.exists():
        log(f"ERROR: no existe la base {DB}")
        return None

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    sweep_stale_temps()
    stamp = now_local().strftime(STAMP)
    final = BACKUP_DIR / f"{PREFIX}{stamp}{SUFFIX}"
    tmp = BACKUP_DIR / f"{PREFIX}{stamp}{SUFFIX}.tmp"

    before = source_state()
    src_mb = DB.stat().st_size / 1024 / 1024
    if dry_run:
        log(f"[dry-run] copiaria {src_mb:.0f} MB a {final.name}")
        return final

    t0 = time.time()
    # `immutable=0` a proposito: queremos ver las escrituras en vuelo, no una
    # vista congelada del archivo. El modo readonly nos impide tocar la base.
    src = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=60)
    try:
        dst = sqlite3.connect(str(tmp))
        try:
            src.backup(dst, pages=2000, sleep=0.01)
            # El backup hereda el journal_mode de la fuente, que es WAL, y eso
            # deja un `-wal` y un `-shm` al lado del archivo. Un backup tiene
            # que ser UN archivo: si alguien se lleva solo el .db y deja los
            # sidecars, restaura una base a la que le faltan las ultimas
            # transacciones. Pasarlo a DELETE consolida todo adentro del .db.
            dst.execute("PRAGMA journal_mode=DELETE")
        finally:
            dst.close()
    finally:
        src.close()

    # Cinturon y tirantes: si algun sidecar sobrevivio igual, se va por nombre
    # literal antes del rename, nunca por glob.
    for sidecar in (f"{tmp}-wal", f"{tmp}-shm", f"{tmp}-journal"):
        if os.path.exists(sidecar):
            os.remove(sidecar)

    # Solo despues de un backup integro le damos el nombre definitivo.
    ok, detail = verify(tmp)
    if not ok:
        log(f"ERROR: el backup recien hecho no pasa la verificacion ({detail}); lo dejo como {tmp.name}")
        return None

    os.replace(tmp, final)
    # Exact copy of the file as it is on disk: the same state before and after
    # the copy, with nothing waiting in the WAL. The app reuses such a copy as
    # its pre-migration backup, and the next run skips while it still matches.
    after = source_state()
    record = {
        "db_mtime_ns": str(after["mtime_ns"]),
        "db_size": after["size"],
        "wal_size": after["wal_size"],
        "exact": before == after and after["wal_size"] == 0,
    }
    with open(sidecar_of(final), "w", encoding="utf-8") as f:
        json.dump(record, f)
    dt = time.time() - t0
    out_mb = final.stat().st_size / 1024 / 1024
    log(f"OK {final.name} — {out_mb:.0f} MB en {dt:.1f}s ({out_mb/max(dt,0.001):.0f} MB/s)")
    return final


def verify(path: Path) -> tuple[bool, str]:
    """integrity_check + una lectura real de la tabla que mas importa."""
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
        try:
            res = con.execute("PRAGMA integrity_check").fetchone()[0]
            if res != "ok":
                return False, f"integrity_check={res}"
            n = con.execute("SELECT COUNT(*) FROM recordings").fetchone()[0]
            v = con.execute("SELECT COUNT(*) FROM vector_embeddings").fetchone()[0]
            return True, f"{n} recordings, {v} chunks"
        finally:
            con.close()
    except Exception as e:  # noqa: BLE001 — cualquier fallo aca es "no sirve"
        return False, f"{type(e).__name__}: {e}"


def parse_stamp(p: Path) -> datetime | None:
    name = p.name
    if not (name.startswith(PREFIX) and name.endswith(SUFFIX)):
        return None
    try:
        naive = datetime.strptime(name[len(PREFIX) : -len(SUFFIX)], STAMP)  # noqa: DTZ007 — el nombre no lleva zona; se le pone la local abajo
        return naive.replace(tzinfo=now_local().tzinfo)
    except ValueError:
        return None


def source_state() -> dict[str, int]:
    """The database file as the file system reports it, to the nanosecond."""
    st = DB.stat()
    wal = DB.parent / f"{DB.name}-wal"
    return {
        "mtime_ns": st.st_mtime_ns,
        "size": st.st_size,
        "wal_size": wal.stat().st_size if wal.exists() else 0,
    }


def sidecar_of(backup: Path) -> Path:
    return backup.with_name(f"{backup.name}.source.json")


def skip_reason(now: datetime | None = None) -> str | None:
    """Por que esta corrida no tiene que copiar nada, o None si tiene que copiar.

    Dos casos, medidos el 24-sep: la base no cambio desde el ultimo backup
    (F: juntaba 72 GB de copias identicas de a 2,9 GB), o la app esta haciendo
    su propio backup antes de actualizar la base. Ese dia las dos copias
    arrancaron con un minuto de diferencia en el mismo disco USB, cada una bajo
    a 4 MB/s, y el splash de la app quedo 3,5 minutos en "Initializing".
    """
    now = now or now_local()
    # La app escribe `hidock.db.bak-<fecha>.partial` mientras copia.
    for p in DB.parent.iterdir():
        if p.name.startswith(f"{DB.name}.bak-") and p.name.endswith(".partial"):
            age = now.timestamp() - p.stat().st_mtime
            if age < 15 * 60:
                return f"la app esta haciendo su propio backup ({p.name})"

    # Sin reloj de por medio: el ultimo backup exacto registro el estado de la
    # base (mtime en ns y tamano, WAL vacio); si la base sigue igual, no cambio.
    # Un cambio de hora o el horario de verano no mueven el mtime de un archivo.
    # Se revisan todos, no el de nombre mas nuevo: despues de atrasar el reloj
    # el nombre mas nuevo puede no ser el ultimo backup hecho.
    now_state = source_state()
    if now_state["wal_size"] != 0:
        return None
    for backup in BACKUP_DIR.glob(f"{PREFIX}*{SUFFIX}"):
        if parse_stamp(backup) is None:
            continue
        try:
            with open(sidecar_of(backup), encoding="utf-8") as f:
                record = json.load(f)
        except (OSError, ValueError):
            continue
        if (
            record.get("exact") is True
            and record.get("db_mtime_ns") == str(now_state["mtime_ns"])
            and record.get("db_size") == now_state["size"]
        ):
            return f"la base no cambio desde {backup.name}"
    return None


def rotate(dry_run: bool = False) -> None:
    """Conserva los N mas nuevos por hora, por dia y por semana.

    Un backup se queda si es el mas reciente de su hora dentro de las ultimas
    KEEP_HOURLY horas, o el mas reciente de su dia dentro de los ultimos
    KEEP_DAILY dias, o el mas reciente de su semana dentro de las ultimas
    KEEP_WEEKLY semanas. Todo lo demas se borra POR NOMBRE, uno por uno.
    """
    backups = sorted(
        ((p, s) for p in BACKUP_DIR.glob(f"{PREFIX}*{SUFFIX}") if (s := parse_stamp(p))),
        key=lambda t: t[1],
        reverse=True,
    )
    if not backups:
        log("no hay backups que rotar")
        return

    now = now_local()
    keep: set[Path] = set()
    for bucket, span, limit in (
        (lambda d: d.strftime("%Y%m%d%H"), timedelta(hours=KEEP_HOURLY), KEEP_HOURLY),
        (lambda d: d.strftime("%Y%m%d"), timedelta(days=KEEP_DAILY), KEEP_DAILY),
        (lambda d: d.strftime("%G%V"), timedelta(weeks=KEEP_WEEKLY), KEEP_WEEKLY),
    ):
        seen: dict[str, Path] = {}
        for path, stamp in backups:
            if now - stamp > span:
                continue
            key = bucket(stamp)
            if key not in seen and len(seen) < limit:
                seen[key] = path
        keep.update(seen.values())

    # El mas nuevo nunca se borra, pase lo que pase con los buckets.
    keep.add(backups[0][0])

    doomed = [p for p, _ in backups if p not in keep]
    if not doomed:
        log(f"rotacion: {len(backups)} backups, ninguno para borrar")
        return

    freed = sum(p.stat().st_size for p in doomed) / 1024 / 1024 / 1024
    log(f"rotacion: conservo {len(keep)}, borro {len(doomed)} ({freed:.1f} GB)")
    for path in doomed:
        # Borrado por ruta literal, nunca por glob ni por variable.
        sidecar = sidecar_of(path)
        if dry_run:
            log(f"  [dry-run] borraria {path.name}")
        else:
            os.remove(str(path))
            if sidecar.exists():
                os.remove(str(sidecar))
            log(f"  borrado {path.name}")


def verify_all() -> int:
    backups = sorted(BACKUP_DIR.glob(f"{PREFIX}*{SUFFIX}"), reverse=True)
    if not backups:
        log("no hay backups")
        return 1
    bad = 0
    for p in backups:
        ok, detail = verify(p)
        gb = p.stat().st_size / 1024 / 1024 / 1024
        log(f"{'OK  ' if ok else 'MAL '} {p.name}  {gb:.2f} GB  {detail}")
        if not ok:
            bad += 1
    log(f"{len(backups)} backups, {bad} con problemas")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--verify-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.verify_only:
        return verify_all()

    reason = skip_reason()
    if reason:
        log(f"sin copia: {reason}")
        rotate(dry_run=args.dry_run)
        return 0
    made = backup_once(dry_run=args.dry_run)
    rotate(dry_run=args.dry_run)
    return 0 if made else 1


if __name__ == "__main__":
    raise SystemExit(main())
