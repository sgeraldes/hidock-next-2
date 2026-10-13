// @category HiDock
// Bounded, read-only verification of current-image C-SKY IRQ/task-switch candidates.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.util.*;

public class ExportTargetScheduler630 extends GhidraScript {
    private static final long[] TARGETS = {
        0x01115716L, 0x01115724L, 0x01115afeL, 0x01115b08L,
        0x01115b0cL, 0x01115c34L, 0x01115c64L, 0x01115d1eL,
        0x0106e26cL
    };
    @Override public void run() throws Exception {
        File out = new File(getScriptArgs()[0]);
        if (!out.isDirectory() && !out.mkdirs()) throw new IOException("Cannot create " + out);
        LinkedHashSet<Function> functions = new LinkedHashSet<>();
        try (PrintWriter meta = new PrintWriter(new File(out, "function-and-xref.tsv"));
             PrintWriter insOut = new PrintWriter(new File(out, "instructions.tsv"));
             PrintWriter refsOut = new PrintWriter(new File(out, "direct-call-edges.tsv"))) {
            meta.println("requested\tentry\tname\tbody_start\tbody_end\tlength\tfunction_at");
            insOut.println("function\taddress\tbytes\tinstruction");
            refsOut.println("caller\taddress\tinstruction\tflow_target");
            for (long raw : TARGETS) {
                Address a = toAddr(raw);
                Function f = getFunctionAt(a);
                boolean exact = f != null;
                if (f == null) f = getFunctionContaining(a);
                if (f == null) {
                    disassemble(a);
                    f = createFunction(a, "target_sched_candidate_" + a);
                    exact = f != null;
                }
                meta.println(a + "\t" + (f == null ? "" : f.getEntryPoint()) + "\t" +
                    (f == null ? "" : clean(f.getName())) + "\t" +
                    (f == null ? "" : f.getBody().getMinAddress()) + "\t" +
                    (f == null ? "" : f.getBody().getMaxAddress()) + "\t" +
                    (f == null ? "" : f.getBody().getNumAddresses()) + "\t" + exact);
                if (f != null) functions.add(f);
                ReferenceIterator xrefs = currentProgram.getReferenceManager().getReferencesTo(a);
                while (xrefs.hasNext()) {
                    Reference r = xrefs.next();
                    Function caller = getFunctionContaining(r.getFromAddress());
                    Instruction src = currentProgram.getListing().getInstructionAt(r.getFromAddress());
                    meta.println("xref\t" + a + "\t" + r.getFromAddress() + "\t" + r.getReferenceType() + "\t" +
                        (caller == null ? "" : caller.getEntryPoint()) + "\t" + (src == null ? "" : clean(src.toString())));
                    if (caller != null) functions.add(caller);
                }
            }
            for (Function f : functions) {
                InstructionIterator it = currentProgram.getListing().getInstructions(f.getBody(), true);
                while (it.hasNext()) {
                    Instruction i = it.next();
                    insOut.println(f.getEntryPoint() + "\t" + i.getAddress() + "\t" + hex(i.getBytes()) + "\t" + clean(i.toString()));
                    if (i.getFlowType().isCall()) {
                        for (Address dest : i.getFlows()) refsOut.println(f.getEntryPoint() + "\t" + i.getAddress() + "\t" + clean(i.toString()) + "\t" + dest);
                    }
                }
            }
        }
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(currentProgram);
        try (PrintWriter c = new PrintWriter(new File(out, "functions.c"))) {
            for (Function f : functions) {
                c.println("/* " + clean(f.getName()) + " @ " + f.getEntryPoint() + " */");
                DecompileResults result = decomp.decompileFunction(f, 20, monitor);
                c.println(result.decompileCompleted() ? result.getDecompiledFunction().getC() : "/* FAILED: " + clean(result.getErrorMessage()) + " */");
                c.println();
            }
        } finally { decomp.dispose(); }
        println("Read-only targeted scheduler export; functions=" + functions.size());
    }
    private String clean(String s) { return s == null ? "" : s.replace('\t', ' ').replace('\n', ' '); }
    private String hex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x & 255)); return s.toString(); }
}
