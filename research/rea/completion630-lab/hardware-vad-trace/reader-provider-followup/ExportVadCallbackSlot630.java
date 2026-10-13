// @category HiDock
// Read-only bounded xref/context export for the current DSP callback slot.
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.*;
import java.io.*;

public class ExportVadCallbackSlot630 extends GhidraScript {
    private final long[] slotWords = {0x00080e68L, 0x00080e6cL, 0x00080e70L, 0x00080e74L, 0x00080e78L};

    @Override
    public void run() throws Exception {
        File out = new File(getScriptArgs()[0]);
        if (!out.isDirectory() && !out.mkdirs()) throw new IOException("Cannot create " + out);
        try (PrintWriter blocks = new PrintWriter(new File(out, "slot-memory.tsv"));
             PrintWriter refs = new PrintWriter(new File(out, "slot-direct-refs.tsv"));
             PrintWriter hits = new PrintWriter(new File(out, "slot-literal-hits.tsv"));
             PrintWriter cellRefs = new PrintWriter(new File(out, "slot-literal-refs.tsv"))) {
            blocks.println("address\tblock\tblock_start\tblock_end\tinitialized\twritable\texecutable\tbytes");
            refs.println("target\tfrom\ttype\tis_read\tis_write\tfunction\tinstruction");
            hits.println("block\tcell\tword");
            cellRefs.println("cell\tfrom\ttype\tfunction\tinstruction");
            for (long raw : slotWords) {
                Address a = toAddr(raw);
                MemoryBlock b = currentProgram.getMemory().getBlock(a);
                String byteText = "unmapped";
                if (b != null && b.isInitialized() && b.getEnd().subtract(a) >= 3) {
                    byte[] bytes = new byte[4];
                    currentProgram.getMemory().getBytes(a, bytes);
                    byteText = hex(bytes);
                }
                blocks.println(a + "\t" + (b == null ? "" : b.getName()) + "\t" +
                    (b == null ? "" : b.getStart()) + "\t" + (b == null ? "" : b.getEnd()) + "\t" +
                    (b != null && b.isInitialized()) + "\t" + (b != null && b.isWrite()) + "\t" +
                    (b != null && b.isExecute()) + "\t" + byteText);
                ReferenceIterator it = currentProgram.getReferenceManager().getReferencesTo(a);
                while (it.hasNext()) {
                    Reference r = it.next();
                    Address from = r.getFromAddress();
                    Instruction ins = currentProgram.getListing().getInstructionAt(from);
                    Function f = getFunctionContaining(from);
                    refs.println(a + "\t" + from + "\t" + r.getReferenceType() + "\t" +
                        r.getReferenceType().isRead() + "\t" + r.getReferenceType().isWrite() + "\t" +
                        (f == null ? "" : f.getName() + "@" + f.getEntryPoint()) + "\t" +
                        (ins == null ? "" : clean(ins.toString())));
                }
            }
            for (MemoryBlock b : currentProgram.getMemory().getBlocks()) {
                if (!b.isInitialized() || b.getSize() > Integer.MAX_VALUE) continue;
                byte[] data = new byte[(int)b.getSize()];
                currentProgram.getMemory().getBytes(b.getStart(), data);
                for (int i = 0; i <= data.length - 4; i++) {
                    long value = (data[i] & 255L) | ((data[i+1] & 255L) << 8) |
                        ((data[i+2] & 255L) << 16) | ((data[i+3] & 255L) << 24);
                    boolean relevant = false;
                    for (long target : slotWords) if (value == target) { relevant = true; break; }
                    if (!relevant) continue;
                    Address cell = b.getStart().add(i);
                    hits.println(b.getName() + "\t" + cell + "\t0x" + String.format("%08x", value));
                    ReferenceIterator it = currentProgram.getReferenceManager().getReferencesTo(cell);
                    while (it.hasNext()) {
                        Reference r = it.next();
                        Address from = r.getFromAddress();
                        Instruction ins = currentProgram.getListing().getInstructionAt(from);
                        Function f = getFunctionContaining(from);
                        cellRefs.println(cell + "\t" + from + "\t" + r.getReferenceType() + "\t" +
                            (f == null ? "" : f.getName() + "@" + f.getEntryPoint()) + "\t" +
                            (ins == null ? "" : clean(ins.toString())));
                    }
                }
            }
        }
        println("Exported exact current-image RAM slot, adjacent words, references, and literal-cell owners.");
    }

    private String hex(byte[] bytes) {
        StringBuilder s = new StringBuilder();
        for (byte b : bytes) s.append(String.format("%02x", b & 0xff));
        return s.toString();
    }
    private String clean(String s) { return s.replace('\t', ' ').replace('\n', ' '); }
}
