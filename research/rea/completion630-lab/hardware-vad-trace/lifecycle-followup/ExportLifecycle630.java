// @category HiDock
// Bounded read-only export for current H1E 6.3.0 VAD scheduler/state lifecycle.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.mem.*;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.util.*;

public class ExportLifecycle630 extends GhidraScript {
    private static final long STATE_SLOT = 0x000852c0L;
    private static final long[] TARGETS = {
        0x010211f0L, 0x01021728L, 0x010217dcL, 0x01021866L,
        0x01020b58L, 0x01020d9cL, 0x01020430L, 0x0102041cL,
        0x01090054L, 0x0109005cL
    };

    @Override
    public void run() throws Exception {
        File out = new File(getScriptArgs()[0]);
        if (!out.isDirectory() && !out.mkdirs()) throw new IOException("Cannot create " + out);
        TreeSet<Long> pointerCells = new TreeSet<>();
        try (PrintWriter hits = new PrintWriter(new File(out, "state-slot-literal-hits.tsv"))) {
            hits.println("block\taddress\tword\trefs_from_cell");
            for (MemoryBlock block : currentProgram.getMemory().getBlocks()) {
                if (!block.isInitialized() || block.getSize() < 4 || block.getSize() > Integer.MAX_VALUE) continue;
                byte[] bytes = new byte[(int) block.getSize()];
                currentProgram.getMemory().getBytes(block.getStart(), bytes);
                for (int i = 0; i <= bytes.length - 4; i++) {
                    if ((bytes[i] & 255) == 0xc0 && (bytes[i+1] & 255) == 0x52 &&
                        (bytes[i+2] & 255) == 0x08 && bytes[i+3] == 0) {
                        Address cell = block.getStart().add(i);
                        pointerCells.add(cell.getOffset());
                        StringJoiner refs = new StringJoiner(";");
                        for (Reference r : currentProgram.getReferenceManager().getReferencesTo(cell)) {
                            Function f = getFunctionContaining(r.getFromAddress());
                            refs.add(r.getFromAddress() + ":" + r.getReferenceType() + ":" +
                                (f == null ? "" : f.getEntryPoint().toString()));
                        }
                        hits.println(block.getName() + "\t" + cell + "\t0x000852c0\t" + refs);
                    }
                }
            }
        }

        Set<Function> selected = new LinkedHashSet<>();
        try (PrintWriter refsOut = new PrintWriter(new File(out, "state-and-function-xrefs.tsv"));
             PrintWriter cellsOut = new PrintWriter(new File(out, "state-slot-references.tsv"));
             PrintWriter clockOut = new PrintWriter(new File(out, "clock-provider-cell.tsv"))) {
            refsOut.println("target\tfrom\ttype\tfunction\tinstruction_or_data");
            for (long raw : TARGETS) {
                Address target = toAddr(raw);
                ReferenceIterator it = currentProgram.getReferenceManager().getReferencesTo(target);
                while (it.hasNext()) {
                    Reference r = it.next();
                    Address from = r.getFromAddress();
                    Function f = getFunctionContaining(from);
                    Instruction ins = currentProgram.getListing().getInstructionAt(from);
                    Data data = currentProgram.getListing().getDataAt(from);
                    refsOut.println(target + "\t" + from + "\t" + r.getReferenceType() + "\t" +
                        (f == null ? "" : f.getName() + "@" + f.getEntryPoint()) + "\t" +
                        (ins != null ? clean(ins.toString()) : data == null || data.getValue() == null ? "" : clean(data.getValue().toString())));
                    if (f != null) selected.add(f);
                }
            }
            for (long cellRaw : pointerCells) {
                Address cell = toAddr(cellRaw);
                ReferenceIterator it = currentProgram.getReferenceManager().getReferencesTo(cell);
                while (it.hasNext()) {
                    Reference r = it.next();
                    Address from = r.getFromAddress();
                    Function f = getFunctionContaining(from);
                    Instruction ins = currentProgram.getListing().getInstructionAt(from);
                    Data data = currentProgram.getListing().getDataAt(from);
                    cellsOut.println(cell + "\t" + from + "\t" + r.getReferenceType() + "\t" +
                        (f == null ? "" : f.getName() + "@" + f.getEntryPoint()) + "\t" +
                        (ins != null ? clean(ins.toString()) : data == null || data.getValue() == null ? "" : clean(data.getValue().toString())));
                    if (f != null) selected.add(f);
                }
            }
            Address clockCell = toAddr(0x0109005cL);
            byte[] clockBytes = new byte[8];
            currentProgram.getMemory().getBytes(clockCell, clockBytes);
            clockOut.println("address\tbytes\tfirst_word\tsecond_word\tfirst_target_mapped");
            int first = currentProgram.getMemory().getInt(clockCell);
            int second = currentProgram.getMemory().getInt(clockCell.add(4));
            clockOut.println(clockCell + "\t" + hex(clockBytes) + "\t0x" + String.format("%08x", first) +
                "\t0x" + String.format("%08x", second) + "\t" + currentProgram.getMemory().contains(toAddr(Integer.toUnsignedLong(first))));
            for (Reference r : currentProgram.getReferenceManager().getReferencesTo(clockCell)) {
                Function f = getFunctionContaining(r.getFromAddress());
                clockOut.println("xref\t" + r.getFromAddress() + "\t" + r.getReferenceType() + "\t" + (f == null ? "" : f.getEntryPoint()));
                if (f != null) selected.add(f);
            }
        }

        // Include exact entry functions and their direct callers from the selected references.
        for (long raw : TARGETS) {
            Function f = getFunctionAt(toAddr(raw));
            if (f != null) selected.add(f);
        }
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(currentProgram);
        try (PrintWriter outC = new PrintWriter(new File(out, "lifecycle-functions.c"));
             PrintWriter outIns = new PrintWriter(new File(out, "lifecycle-functions.tsv"))) {
            outIns.println("function\taddress\tbytes\tinstruction");
            for (Function f : selected) {
                DecompileResults result = decomp.decompileFunction(f, 30, monitor);
                outC.println("/* " + f.getName() + " @ " + f.getEntryPoint() + " */");
                outC.println(result.decompileCompleted() ? result.getDecompiledFunction().getC() : result.getErrorMessage());
                outC.println();
                InstructionIterator it = currentProgram.getListing().getInstructions(f.getBody(), true);
                while (it.hasNext()) {
                    Instruction ins = it.next();
                    outIns.println(f.getEntryPoint() + "\t" + ins.getAddress() + "\t" + hex(ins.getBytes()) + "\t" + clean(ins.toString()));
                }
            }
        } finally { decomp.dispose(); }
        println("Exported state-slot literal references, target xrefs, clock-cell bytes, and referenced lifecycle functions.");
    }

    private String clean(String s) { return s.replace('\t', ' ').replace('\n', ' '); }
    private String hex(byte[] bytes) {
        StringBuilder s = new StringBuilder();
        for (byte b : bytes) s.append(String.format("%02x", b & 255));
        return s.toString();
    }
}
