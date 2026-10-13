// @category HiDock
// Exact xrefs and mapped-memory status for helper-owned literals/target field only.
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.mem.*;
import ghidra.program.model.symbol.*;
import java.io.*;

public class ExportEndpointPointerRefs630 extends GhidraScript {
  private static final long[] TARGETS = {0x0104f528L, 0x000867d6L, 0x0106a840L};
  public void run() throws Exception {
    File out = new File(getScriptArgs()[0]);
    if (!out.isDirectory() && !out.mkdirs()) throw new IOException("Cannot create output directory");
    try (PrintWriter w = new PrintWriter(new File(out, "exact-pointer-references.tsv"))) {
      w.println("target\tmemory_block\tfrom\tref_type\tfunction\tinstruction_or_data");
      for (long value : TARGETS) {
        monitor.checkCancelled();
        Address target = toAddr(value);
        MemoryBlock block = currentProgram.getMemory().getBlock(target);
        ReferenceIterator it = currentProgram.getReferenceManager().getReferencesTo(target);
        boolean any = false;
        while (it.hasNext()) {
          Reference r = it.next(); any = true;
          Address from = r.getFromAddress();
          Instruction i = currentProgram.getListing().getInstructionAt(from);
          Data d = currentProgram.getListing().getDataAt(from);
          Function f = getFunctionContaining(from);
          String shown = i != null ? i.toString() : d != null ? String.valueOf(d.getValue()) : "";
          w.println(target + "\t" + (block == null ? "<unmapped>" : block.getName()+":"+block.getStart()+"-"+block.getEnd()) + "\t" + from + "\t" + r.getReferenceType() + "\t" + (f == null ? "" : f.getEntryPoint()) + "\t" + shown);
        }
        if (!any) w.println(target + "\t" + (block == null ? "<unmapped>" : block.getName()+":"+block.getStart()+"-"+block.getEnd()) + "\t\t\t\t<no saved references>");
      }
    }
    println("Queried only three exact addresses; no analysis or code creation requested.");
  }
}
