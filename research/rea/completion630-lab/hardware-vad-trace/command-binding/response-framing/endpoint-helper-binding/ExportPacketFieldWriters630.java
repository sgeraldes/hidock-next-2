// @category HiDock
// Read-only exact follow-up for saved readers/writers of RAM halfword 0x867d6.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;

public class ExportPacketFieldWriters630 extends GhidraScript {
  private static final long[] FUNS = {0x0104f52cL, 0x0104f6a0L};
  public void run() throws Exception {
    File out = new File(getScriptArgs()[0]);
    if (!out.isDirectory() && !out.mkdirs()) throw new IOException("Cannot create output directory");
    DecompInterface d = new DecompInterface(); d.openProgram(currentProgram);
    try (PrintWriter c = new PrintWriter(new File(out, "decompiled.c"));
         PrintWriter ins = new PrintWriter(new File(out, "functions.tsv"));
         PrintWriter refs = new PrintWriter(new File(out, "incoming.tsv"));
         PrintWriter raw = new PrintWriter(new File(out, "uncontained-writer-window.tsv"))) {
      ins.println("target\tentry\tbody\tsize\taddress\tbytes\tinstruction");
      refs.println("target\tfrom\tref_type\tcaller\tinstruction");
      raw.println("address\tfunction_containing\tbytes\tinstruction");
      for (long value : FUNS) {
        monitor.checkCancelled(); Address a = toAddr(value); Function f = getFunctionAt(a);
        if (f == null) { ins.println(a+"\t<no saved function>\t\t\t\t\t"); continue; }
        c.println("/* " + f.getName() + " @ " + f.getEntryPoint() + " body=" + f.getBody() + " */");
        DecompileResults r = d.decompileFunction(f, 15, monitor);
        c.println(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "/* FAILED: "+r.getErrorMessage()+" */");
        InstructionIterator ii = currentProgram.getListing().getInstructions(f.getBody(), true);
        while (ii.hasNext()) { Instruction i=ii.next(); ins.println(a+"\t"+f.getEntryPoint()+"\t"+f.getBody()+"\t"+f.getBody().getNumAddresses()+"\t"+i.getAddress()+"\t"+hex(i.getBytes())+"\t"+i); }
        ReferenceIterator ri = currentProgram.getReferenceManager().getReferencesTo(f.getEntryPoint());
        while(ri.hasNext()) { Reference x=ri.next(); Function caller=getFunctionContaining(x.getFromAddress()); Instruction i=currentProgram.getListing().getInstructionAt(x.getFromAddress()); refs.println(a+"\t"+x.getFromAddress()+"\t"+x.getReferenceType()+"\t"+(caller==null?"":caller.getEntryPoint())+"\t"+(i==null?"":i)); }
      }
      Address start=toAddr(0x0104f480L), end=toAddr(0x0104f510L);
      InstructionIterator wi=currentProgram.getListing().getInstructions(start,true);
      while(wi.hasNext()) { Instruction i=wi.next(); if(i.getAddress().compareTo(end)>=0) break; Function f=getFunctionContaining(i.getAddress()); raw.println(i.getAddress()+"\t"+(f==null?"":f.getEntryPoint())+"\t"+hex(i.getBytes())+"\t"+i); }
    } finally { d.dispose(); }
    println("Exported only two direct field reader/writer functions and one 0x90-byte saved-listing window.");
  }
  private String hex(byte[] b) { StringBuilder s=new StringBuilder(); for(byte v:b)s.append(String.format("%02x",v&255)); return s.toString(); }
}
