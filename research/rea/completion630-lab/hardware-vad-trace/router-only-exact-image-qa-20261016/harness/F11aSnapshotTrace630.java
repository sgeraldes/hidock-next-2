// One F11A response fixture over the already imported exact pinned SYS.
import ghidra.app.emulator.EmulatorHelper;
import ghidra.program.model.listing.Instruction;
import java.nio.file.*;
import java.util.*;
import com.google.gson.*;

public class F11aSnapshotTrace630 extends BoundedNativeContract630 {
    static final long SLOT=0x852c0L, EXIT=0x3ff000L, FRAME=0x300000L,
        HEAD=0x301000L, OUT=0x304000L, OBJECT=0x330000L, SP=0x38f000L;
    int valueAt(EmulatorHelper e,long a)throws Exception{return value(e,a);}
    long reg(EmulatorHelper e,String n){return e.readRegister(n).longValue()&0xffffffffL;}
    void le32(EmulatorHelper e,long a,long v)throws Exception{e.writeMemoryValue(toAddr(a),4,v&0xffffffffL);}
    byte[] read(EmulatorHelper e,long a,int n)throws Exception{return e.readMemory(toAddr(a),n);}
    String hex(byte[] b){return HexFormat.of().formatHex(b);}

    EmulatorHelper fresh()throws Exception{
        EmulatorHelper e=new EmulatorHelper(currentProgram);
        for(int n=0;n<14;n++)e.writeRegister("r"+n,0);
        e.writeRegister("sp",SP);e.writeRegister("lr",EXIT);e.writeRegister("psr",0);
        e.writeMemory(toAddr(0x2ff000L),new byte[0x6000]);
        e.writeMemory(toAddr(0x32f000L),new byte[0x2000]);
        e.writeMemory(toAddr(0x38e000L),new byte[0x2000]);
        le32(e,SLOT,0);
        return e;
    }

    @Override public void run()throws Exception{
        EmulatorHelper e=fresh();
        e.writeMemory(toAddr(OBJECT),new byte[0x60]);
        e.writeMemoryValue(toAddr(OBJECT),1,1);le32(e,SLOT,OBJECT);
        long[] tail={8,5,4,0,0x87654321L,0,0,1};
        for(int i=0;i<tail.length;i++)le32(e,OBJECT+0x40+4L*i,tail[i]);
        e.writeMemory(toAddr(FRAME),new byte[0x80]);e.writeMemory(toAddr(HEAD),new byte[16]);
        e.writeMemory(toAddr(OUT),new byte[64]);
        le32(e,FRAME+0x18,0xf11a);le32(e,FRAME+0x1c,OUT);le32(e,FRAME+0x20,32);le32(e,FRAME+0x28,HEAD);
        e.writeMemoryValue(toAddr(HEAD+8),1,0);e.writeMemoryValue(toAddr(HEAD+9),1,1);
        println("fixture cmd="+hex(read(e,FRAME+0x18,4))+" out="+Long.toHexString(Integer.toUnsignedLong(valueAt(e,FRAME+0x1c)))+
            " cap="+Integer.toUnsignedLong(valueAt(e,FRAME+0x20))+" head="+Long.toHexString(Integer.toUnsignedLong(valueAt(e,FRAME+0x28)))+
            " headBytes="+hex(read(e,HEAD,12)));
        e.writeRegister("r0",FRAME);
        e.writeRegister("pc",0x01128bf4L);
        int steps=0;long pc;
        while((pc=e.getExecutionAddress().getOffset())!=EXIT&&steps<5000){
            Instruction ins=getInstructionAt(toAddr(pc));if(ins==null){disassemble(toAddr(pc));ins=getInstructionAt(toAddr(pc));}
            if(steps<120||steps%250==0||pc==EXIT) println(String.format("TRACE %03d pc=%08x r0=%08x r1=%08x r2=%08x r3=%08x %s",steps,pc,
                (int)reg(e,"r0"),(int)reg(e,"r1"),(int)reg(e,"r2"),(int)reg(e,"r3"),ins==null?"<undecodable>":ins.toString()));
            step(e);steps++;
        }
        println(String.format("RESULT steps=%d pc=%08x r0=%08x out=%s",steps,pc,(int)reg(e,"r0"),hex(read(e,OUT,48))));
        e.dispose();
    }
}
