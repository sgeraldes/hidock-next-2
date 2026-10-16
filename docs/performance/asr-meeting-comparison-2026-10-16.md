# Motores de transcripción sobre reuniones, 16-oct-2026

Para qué: elegir los motores de respaldo de la cadena de transcripción (plan
`docs/superpowers/plans/2026-10-16-transcription-retry-and-fallback.md`, fase C). Pedido de Sebastián
del 15-oct: si Gemini falla, pasar a la gamestation o a local según esté disponible; Cohere le parece el
peor de los disponibles.

## Cómo se midió

- Motores de la gamestation (Model Host 0.5.3, RTX 4090): cada modelo se preparó con
  `POST /runtime/prepare-asr`, se esperó a que `/health` lo anunciara y se corrió un job de
  transcripción por clip, uno por vez. Gemini 3.5 Transcribe con la llamada nativa que hace
  `GeminiEngine` (verbatim, tiempo por palabra), en piezas de 300 s con 65 s entre pedidos por la cuota
  gratuita.
- Tres conjuntos:
  - FLEURS es-419, 30 clips, 853 palabras, lectura en voz alta, referencia humana (medido el 11-oct,
    `docs/performance/asr-observed-accuracy-2026-10-11.md`).
  - AMI, 6 ventanas de 30 s de tres reuniones en inglés, 377 palabras, referencia humana publicada.
    Puntaje con `apps/model-host/scripts/asr-accuracy/score.py`, WER normalizado.
  - Rec08 (Delivery del 13-oct), 600 a 1200 s de cada canal por separado, español, sin referencia
    humana. Se mide cuántas palabras salen y cuánto difiere cada texto del de Gemini (WER normalizado
    del motor contra Gemini: es acuerdo, no exactitud).
- Las muestras son chicas. Diferencias de uno o dos puntos no separan motores.

## Resultados

| Motor | FLEURS es WER | AMI WER | Rec08 palabras ch0 / ch1 | Rec08 diferencia con Gemini ch0 / ch1 | Tiempo por 10 min |
|---|---|---|---|---|---|
| Gemini 3.5 Transcribe | sin medir | 19,4% | 364 / 632 | (referencia) | 148 s |
| Parakeet Ultra | 3,2% | 17,8% | 349 / 676 | 0,30 / 0,25 | 6 s |
| Qwen3-ASR 1.7B | 3,5% | 20,2% | 385 / 679 | 0,26 / 0,26 | 11 a 14 s |
| Cohere Transcribe | 3,6% | 21,2% | 353 / 697 | 0,31 / 0,32 | 24 a 29 s |
| Parakeet v3 | 2,7% | 16,7% | 287 / 530 | 0,40 / 0,36 | 15 s |
| Nemotron 3.5 0.6B | 6,6% | 21,8% | 279 / 556 | 0,43 / 0,42 | 15 s |

Lo que deciden:
- Parakeet v3 es el mejor en lectura y en AMI, pero en la reunión en español devolvió alrededor de un
  quinto menos de palabras que los demás: pierde texto en conversación.
- Parakeet Ultra queda entre los primeros en los tres conjuntos y es el más rápido.
- Qwen 1.7B da el texto más parecido al de Gemini en la reunión en español.
- Cohere queda afuera del orden por defecto: no se destaca en ninguno y el 15-oct inventó texto sobre
  silencio en Rec09 ("Gracias." repetido, 56 s de sonido en 48 min).

Orden por defecto de la cadena: Gemini, Parakeet Ultra en la gamestation, Qwen 1.7B en la gamestation.
El runner local de esta PC solo trae Cohere y VibeVoice, así que no entra por defecto; cuando no hay
motor disponible la grabación espera en la cola en vez de terminar en error.

## Limitaciones

- "Texto sobre silencio" no se puede comparar entre motores con esta salida: Parakeet v3 y otros
  devuelven ventanas de unos 29 s que incluyen las pausas de la conversación.
- Sin referencia humana en español de reunión. Para cerrar la elección hace falta revisar a mano unos
  minutos de una reunión real.
- Gemini no se corrió sobre FLEURS en esta pasada.

Datos crudos (hipótesis por motor, puntajes, scripts): scratchpad de la sesión del 16-oct, fuera del repo
porque contienen texto de reuniones.
