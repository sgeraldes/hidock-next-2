// @category HiDock
// Read-only bounded export of packet/capacity helpers and their direct getters.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.util.*;

public class ExportEndpointHelpers630 extends GhidraScript {
    private static final long[] TARGETS = {
        0x0104f520L, 0x0104f66cL, 0x0104f674L, 0x0106a818L, 0x0106a844L
    };
    public void run() throws Exception {
        File out = new File(getScriptArgs()[0]);
        if (!out.isDirectory() && !out.mkdirs()) throw new IOException("Cannot create output directory");
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(currentProgram);
        try (PrintWriter c = new PrintWriter(new File(out, "decompiled.c"));
             PrintWriter ins = new PrintWriter(new File(out, "instructions.tsv"));
             PrintWriter funcs = new PrintWriter(new File(out, "functions.tsv"));
             PrintWriter refs = new PrintWriter(new File(out, "incoming-references.tsv"))) {
            ins.println("target\taddress\tbytes\tinstruction");
            funcs.println("target\tfunction_found\tname\tentry\tbody\tsize\tsignature");
            refs.println("target\tfrom\tref_type\tcaller\tinstruction");
            for (long raw : TARGETS) {
                monitor.checkCancelled();
                Address address = toAddr(raw);
                Function f = getFunctionAt(address);
                if (f == null) {
                    funcs.println(address + "\tfalse\t\t\t\t\t");
                    // Preserve the saved listing only; do not create functions or disassemble.
                    Instruction i = currentProgram.getListing().getInstructionAt(address);
                    if (i != null) {
                        int n = 0;
                        while (i != null && n++ < 64) {
                            ins.println(address + "\t" + i.getAddress() + "\t" + hex(i.getBytes()) + "\t" + i);
                            i = currentProgram.getListing().getInstructionAfter(i.getAddress());
                        }
                    }
                    continue;
                }
                funcs.println(address + "\ttrue\t" + f.getName() + "\t" + f.getEntryPoint() + "\t" + f.getBody() + "\t" + f.getBody().getNumAddresses() + "\t" + f.getSignature());
                c.println("/* " + f.getName() + " @ " + f.getEntryPoint() + " body=" + f.getBody() + " */");
                DecompileResults result = decomp.decompileFunction(f, 15, monitor);
                c.println(result.decompileCompleted() ? result.getDecompiledFunction().getC()
                    : "/* DECOMPILATION FAILED: " + result.getErrorMessage() + " */");
                InstructionIterator ii = currentProgram.getListing().getInstructions(f.getBody(), true);
                while (ii.hasNext()) {
                    Instruction i = ii.next();
                    ins.println(address + "\t" + i.getAddress() + "\t" + hex(i.getBytes()) + "\t" + i);
                }
                ReferenceIterator incoming = currentProgram.getReferenceManager().getReferencesTo(f.getEntryPoint());
                while (incoming.hasNext()) {
                    Reference r = incoming.next();
                    Instruction i = currentProgram.getListing().getInstructionAt(r.getFromAddress());
                    Function caller = getFunctionContaining(r.getFromAddress());
                    refs.println(address + "\t" + r.getFromAddress() + "\t" + r.getReferenceType() + "\t" +
                        (caller == null ? "" : caller.getEntryPoint()) + "\t" + (i == null ? "" : i.toString()));
                }
            }
        } finally { decomp.dispose(); }
        println("Exported only five named helper/getter addresses; no analysis or function creation requested.");
    }
    private String hex(byte[] bytes) {
        StringBuilder s = new StringBuilder();
        for (byte b : bytes) s.append(String.format("%02x", b & 0xff));
        return s.toString();
    }
}
