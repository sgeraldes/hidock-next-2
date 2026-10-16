// @category HiDock
// Bounded execution of the pinned combined image's linked CK802 VAD paths.
import ghidra.app.emulator.EmulatorHelper;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import com.google.gson.*;

public class VadExactQa630 extends BoundedNativeContract630 {
    static final long IMAGE_BASE = 0x01000000L;
    static final long SLOT = 0x000852c0L;
    static final long PENDING = 0x000855dcL;
    static final long GETTER = 0x0101fb68L;
    static final long CTOR_OK = 0x01021038L;
    static final long CTOR_FAIL = 0x01021074L;
    static final long EXIT = 0x003ff000L;
    static final long FRAME = 0x00300000L;
    static final long HEAD = 0x00301000L;
    static final long CTX = 0x00302000L;
    static final long BODY = 0x00303000L;
    static final long OUT = 0x00304000L;
    static final long OBJECT = 0x00330000L;
    JsonObject cfg;
    Map<String, Long> address = new LinkedHashMap<>();
    List<Map<String, Object>> cases = new ArrayList<>();
    int getterStatus;
    long getterWord;
    int getterCalls;
    int aliasHits;
    long currentAlias;
    String failure;

    long reg(EmulatorHelper e, String name) { return e.readRegister(name).longValue() & 0xffffffffL; }
    void le32(EmulatorHelper e, long at, long value) throws Exception { e.writeMemoryValue(toAddr(at), 4, value & 0xffffffffL); }
    void le16(EmulatorHelper e, long at, int value) throws Exception { e.writeMemoryValue(toAddr(at), 2, value & 0xffff); }
    byte[] read(EmulatorHelper e, long at, int n) throws Exception { return e.readMemory(toAddr(at), n); }
    String hex(byte[] bytes) { return HexFormat.of().formatHex(bytes); }

    EmulatorHelper fresh() throws Exception {
        EmulatorHelper e = new EmulatorHelper(currentProgram);
        for (int n = 0; n < 14; n++) e.writeRegister("r" + n, 0);
        e.writeRegister("sp", 0x0038f000L);
        e.writeRegister("lr", EXIT);
        e.writeRegister("psr", 0);
        e.writeMemory(toAddr(0x002ff000L), new byte[0x6000]);
        e.writeMemory(toAddr(0x0032f000L), new byte[0x2000]);
        e.writeMemory(toAddr(0x0038e000L), new byte[0x2000]);
        le32(e, SLOT, 0);
        le16(e, PENDING, 0);
        e.writeMemoryValue(toAddr(0x000855ccL), 1, 0);
        return e;
    }

    int execute(EmulatorHelper e, long entry, long exit) throws Exception {
        e.writeRegister("pc", entry);
        int steps = 0;
        long start = System.nanoTime();
        while (e.getExecutionAddress().getOffset() != exit) {
            if (++steps > 150000 || System.nanoTime() - start > 15_000_000_000L)
                throw new IllegalStateException("instruction bound at " + e.getExecutionAddress());
            long pc = e.getExecutionAddress().getOffset();
            if (pc == currentAlias) aliasHits++;
            if (pc == GETTER) {
                getterCalls++;
                long output = reg(e, "r0");
                if (output < 0x0038e000L || output >= 0x00390000L) throw new IllegalStateException("native getter output pointer bound");
                e.writeMemoryValue(toAddr(output), 4, getterWord & 0xffffffffL);
                e.writeRegister("r0", getterStatus & 0xffffffffL);
                e.writeRegister("pc", reg(e, "lr"));
                continue;
            }
            if (pc < IMAGE_BASE)
                throw new IllegalStateException("unmodeled ROM instruction fetch at " + String.format("0x%08x", pc));
            step(e);
        }
        return steps;
    }

    void add(String id, boolean pass, Object expected, Object actual, int steps, int modeledGetterCalls) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", id);
        row.put("status", pass ? "passed" : "failed");
        row.put("expected", expected);
        row.put("actual", actual);
        row.put("executed_instructions", steps);
        row.put("modeled_native_getter_calls", modeledGetterCalls);
        cases.add(row);
        println(id + " " + (pass ? "PASS" : "FAIL") + " actual=" + actual);
    }

    long address(String key) { return address.get(key); }

    void constructorCase(boolean success) throws Exception {
        EmulatorHelper e = fresh();
        long privateObject = OBJECT;
        long stop = success ? CTOR_OK : CTOR_FAIL;
        e.writeRegister("r4", success ? 0 : 1);
        e.writeRegister("r5", SLOT);
        e.writeRegister("r7", privateObject);
        le32(e, SLOT, 0);
        int steps = execute(e, address("publication_stub"), stop);
        long published = Integer.toUnsignedLong(value(e, SLOT));
        boolean pass = published == (success ? privateObject : 0) && e.getExecutionAddress().getOffset() == stop;
        add(success ? "constructor-publication-success-branch" : "constructor-publication-failure-branch",
            pass, Map.of("publication_slot", success ? privateObject : 0, "continuation", String.format("0x%08x", stop)),
            Map.of("publication_slot", published, "continuation", String.format("0x%08x", e.getExecutionAddress().getOffset())), steps, 0);
        e.dispose();
    }

    void setupF11aResponse(EmulatorHelper e, long slot, int nativeState, long[] telemetry) throws Exception {
        e.writeMemory(toAddr(OBJECT), new byte[0x60]);
        le32(e, SLOT, slot);
        if (slot != 0) {
            e.writeMemoryValue(toAddr(OBJECT), 1, nativeState);
            for (int i = 0; i < telemetry.length; i++) le32(e, OBJECT + 0x40 + 4L * i, telemetry[i]);
        }
        e.writeMemory(toAddr(FRAME), new byte[0x80]);
        e.writeMemory(toAddr(HEAD), new byte[16]);
        e.writeMemory(toAddr(OUT), new byte[64]);
        le32(e, FRAME + 0x18, 0xf11a);
        le32(e, FRAME + 0x1c, OUT);
        le32(e, FRAME + 0x20, 32);
        le32(e, FRAME + 0x28, HEAD);
        e.writeMemoryValue(toAddr(HEAD + 8), 1, 0);
        e.writeMemoryValue(toAddr(HEAD + 9), 1, 1);
    }

    void snapshotCase(boolean present) throws Exception {
        EmulatorHelper e = fresh();
        long[] words = present
            ? new long[]{8, 5, 4, 0, 0x87654321L, 0, 0, 1}
            : new long[8];
        setupF11aResponse(e, present ? OBJECT : 0, 1, words);
        getterCalls = 0;
        int steps = execute(e, address("console_response"), EXIT);
        int result = (int)reg(e, "r0");
        byte[] reply = read(e, OUT + 12, 32);
        boolean pass = result == 32 && (present
            ? (reply[0] == 0 && reply[1] == 1 && reply[2] == 1 && reply[3] == 1 && be32(reply, 4) == 5 && be32(reply, 8) == 4 && be32(reply, 16) == 0x87654321L && be32(reply, 28) == 8)
            : (reply[0] == 2 && reply[1] == 1 && reply[2] == 0 && reply[3] == 0 && allZero(reply, 4, 28))) && getterCalls == 0;
        Map<String, Object> actual = new LinkedHashMap<>();
        actual.put("return", result); actual.put("reply_hex", hex(reply)); actual.put("getter_calls", getterCalls);
        add(present ? "f11a-present-snapshot-response" : "f11a-absent-snapshot-response", pass,
            present ? "OK/HAS_SAMPLE with fixture telemetry" : "UNAVAILABLE with zero payload and no getter",
            actual, steps, getterCalls);
        e.dispose();
    }

    long be32(byte[] b, int at) {
        return ((long)(b[at] & 255) << 24) | ((long)(b[at + 1] & 255) << 16) | ((long)(b[at + 2] & 255) << 8) | (b[at + 3] & 255L);
    }
    boolean allZero(byte[] b, int from, int to) { for (int i = from; i < to; i++) if (b[i] != 0) return false; return true; }

    void pollCase(int status, long word) throws Exception {
        EmulatorHelper e = fresh();
        e.writeMemory(toAddr(OBJECT), new byte[0x60]);
        e.writeMemoryValue(toAddr(OBJECT), 1, 1);
        le32(e, SLOT, OBJECT);
        getterStatus = status; getterWord = word; getterCalls = 0;
        int steps = execute(e, address("poll_bridge"), EXIT);
        int returned = (int)reg(e, "r0");
        long[] tail = new long[8];
        for (int i = 0; i < tail.length; i++) tail[i] = Integer.toUnsignedLong(value(e, OBJECT + 0x40 + 4L * i));
        boolean pass = returned == status && getterCalls == 1 && tail[0] == 2 && tail[1] == 1 && tail[2] == (status == 0 ? 1 : 0) && tail[3] == (status & 0xffffffffL) && tail[4] == (status == 0 ? word & 0xffffffffL : 0) && tail[5] == 0 && tail[6] == 0 && (tail[7] & 1) == (status == 0 ? 1 : 0);
        Map<String, Object> actual = new LinkedHashMap<>();
        actual.put("return", returned); actual.put("getter_calls", getterCalls); actual.put("tail_words_le32", tail);
        add(status == 0 ? "poll-bridge-success" : "poll-bridge-failure", pass,
            "one modeled getter call; actual bridge/binding/guard instructions update telemetry tail", actual, steps, getterCalls);
        e.dispose();
    }

    void forwardingCase(boolean response) throws Exception {
        EmulatorHelper direct = fresh();
        EmulatorHelper wrapped = fresh();
        long frame = FRAME, head = HEAD, ctx = CTX, body = BODY;
        int stepsDirect, stepsWrapped;
        long alias = address(response ? "current_response" : "current_parse");
        currentAlias = alias;
        aliasHits = 0;
        byte[] directReply = new byte[0];
        byte[] wrappedReply = new byte[0];
        if (!response) {
            setupHelpParse(direct); setupHelpParse(wrapped);
            eReg(direct, "r0", frame); eReg(direct, "r1", body); eReg(direct, "r2", 4);
            stepsDirect = execute(direct, alias, EXIT); int directResult = (int)reg(direct, "r0");
            byte[] directHead = read(direct, head, 12);
            eReg(wrapped, "r0", frame); eReg(wrapped, "r1", body); eReg(wrapped, "r2", 4);
            aliasHits = 0;
            stepsWrapped = execute(wrapped, address("console_parse"), EXIT); int wrappedResult = (int)reg(wrapped, "r0");
            byte[] wrappedHead = read(wrapped, head, 12);
            boolean pass = directResult == wrappedResult && Arrays.equals(directHead, wrappedHead) && wrappedHead[8] == 0 && wrappedHead[9] == 1 && aliasHits == 1;
            add("non-vad-parser-forward-to-exact-current-alias", pass,
                "F117 help parser result/state equals direct current-alias execution",
                Map.of("direct_return", directResult, "wrapped_return", wrappedResult, "head_hex", hex(wrappedHead), "alias_hits", aliasHits),
                stepsDirect + stepsWrapped, 0);
        } else {
            setupHelpResponse(direct); setupHelpResponse(wrapped);
            eReg(direct, "r0", frame); stepsDirect = execute(direct, alias, EXIT); int directResult = (int)reg(direct, "r0");
            directReply = read(direct, OUT, 48);
            aliasHits = 0;
            eReg(wrapped, "r0", frame); aliasHits = 0; stepsWrapped = execute(wrapped, address("console_response"), EXIT); int wrappedResult = (int)reg(wrapped, "r0");
            wrappedReply = read(wrapped, OUT, 48);
            boolean pass = directResult == wrappedResult && Arrays.equals(directReply, wrappedReply) && wrappedResult > 0 && aliasHits == 1;
            add("non-vad-response-forward-to-exact-current-alias", pass,
                "F117 help response and output equal direct current-alias execution",
                Map.of("direct_return", directResult, "wrapped_return", wrappedResult, "output_hex", hex(wrappedReply), "alias_hits", aliasHits),
                stepsDirect + stepsWrapped, 0);
        }
        currentAlias = 0;
        direct.dispose(); wrapped.dispose();
    }

    void setupHelpParse(EmulatorHelper e) throws Exception {
        e.writeMemory(toAddr(FRAME), new byte[0x80]); e.writeMemory(toAddr(HEAD), new byte[16]);
        e.writeMemory(toAddr(CTX), new byte[0x20]); e.writeMemory(toAddr(BODY), new byte[]{'h','e','l','p'});
        le32(e, FRAME + 0x14, HEAD); le32(e, FRAME + 0x1c, CTX);
        e.writeMemoryValue(toAddr(HEAD + 2), 1, 0xf1); e.writeMemoryValue(toAddr(HEAD + 3), 1, 0x17);
        e.writeMemory(toAddr(HEAD + 8), new byte[]{0,0,0,4});
        le16(e, PENDING, 0xf117); le32(e, CTX + 0x10, 0);
    }
    void setupHelpResponse(EmulatorHelper e) throws Exception {
        e.writeMemory(toAddr(FRAME), new byte[0x80]); e.writeMemory(toAddr(HEAD), new byte[16]); e.writeMemory(toAddr(OUT), new byte[64]);
        le32(e, FRAME + 0x18, 0xf117); le32(e, FRAME + 0x1c, OUT); le32(e, FRAME + 0x20, 52); le32(e, FRAME + 0x28, HEAD);
        e.writeMemoryValue(toAddr(HEAD + 8), 1, 0); e.writeMemoryValue(toAddr(HEAD + 9), 1, 1);
    }
    void eReg(EmulatorHelper e, String name, long value) throws Exception { e.writeRegister(name, value); }

    void verifyImage() throws Exception {
        byte[] image = Files.readAllBytes(Path.of(cfg.get("image").getAsString()));
        String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(image));
        if (!sha.equals(cfg.get("image_sha256").getAsString())) throw new IllegalStateException("pinned image SHA mismatch");
        if (image.length != cfg.get("image_bytes").getAsInt()) throw new IllegalStateException("pinned image byte count mismatch");
        byte[] imported = new byte[image.length];
        currentProgram.getMemory().getBytes(toAddr(IMAGE_BASE), imported);
        if (!Arrays.equals(image, imported)) throw new IllegalStateException("Ghidra imported bytes differ from pinned SYS");
    }

    @Override public void run() throws Exception {
        Path receiptPath = Path.of(getScriptArgs()[1]);
        try {
            cfg = JsonParser.parseString(Files.readString(Path.of(getScriptArgs()[0]))).getAsJsonObject();
            verifyImage();
            JsonObject addresses = cfg.getAsJsonObject("addresses");
            for (String k : List.of("console_parse", "console_response", "poll_bridge", "publication_stub", "current_parse", "current_response"))
                address.put(k, Long.decode(addresses.get(k).getAsString()));
            constructorCase(true); constructorCase(false);
            snapshotCase(false); snapshotCase(true);
            pollCase(0, 0x87654321L); pollCase(-5, 0xdeadbeefL);
            forwardingCase(false); forwardingCase(true);
            long failed = cases.stream().filter(c -> !"passed".equals(c.get("status"))).count();
            Map<String, Object> receipt = new LinkedHashMap<>();
            receipt.put("status", failed == 0 ? "passed_exact_image_instruction_fixtures" : "failed_exact_image_instruction_fixtures");
            receipt.put("image_sha256", cfg.get("image_sha256").getAsString()); receipt.put("elf_sha256", cfg.get("elf_sha256").getAsString());
            receipt.put("image_bytes", cfg.get("image_bytes").getAsInt()); receipt.put("layout_sha256", cfg.get("layout_sha256").getAsString());
            receipt.put("symbols_sha256", cfg.get("symbols_sha256").getAsString());
            receipt.put("boundary", "Exact imported candidate instructions for final publication decision, F11A response/binding snapshot absent/present, poll bridge/binding/IRQ guard and non-F11A parser/response forwarding. Fixture RAM only. Native getter at 0x0101fb68 is explicitly modeled once with configured return/status; no DSP, USB, live RAM, timing, boot, installation, lifetime or hardware semantics are established.");
            receipt.put("cases", cases);
            Files.writeString(receiptPath, new GsonBuilder().setPrettyPrinting().create().toJson(receipt) + "\n");
            println("Wrote bounded exact-image receipt " + receiptPath + "; cases=" + cases.size() + ", failed=" + failed);
        } catch (Exception ex) {
            Map<String, Object> receipt = new LinkedHashMap<>();
            receipt.put("status", "blocked_or_failed_exact_instruction_execution");
            if (cfg != null) { receipt.put("image_sha256", cfg.get("image_sha256").getAsString()); receipt.put("elf_sha256", cfg.get("elf_sha256").getAsString()); }
            receipt.put("error", ex.toString()); receipt.put("cases", cases);
            Files.writeString(receiptPath, new GsonBuilder().setPrettyPrinting().create().toJson(receipt) + "\n");
            println("FAIL exact-instruction gate: " + ex);
        }
    }
}
