// @category HiDock
// Four bounded CK802 instruction fixtures against the exact 393993 decoded SYS.
import ghidra.app.emulator.EmulatorHelper;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import com.google.gson.*;

public class VadExactQa393993 extends BoundedNativeContract630 {
    static final long IMAGE_BASE = 0x01000000L;
    static final long SLOT = 0x000852c0L;
    static final long PENDING = 0x000855dcL;
    static final long GETTER = 0x0101fb68L;
    static final long POLL_HOOK = 0x01020b62L;
    static final long POLL_CONT = 0x01020b66L;
    static final long EXIT = 0x003ff000L;
    static final long FRAME = 0x00300000L;
    static final long HEAD = 0x00301000L;
    static final long OUT = 0x00304000L;
    static final long OBJECT = 0x00330000L;
    static final long GETTER_OUTPUT = 0x0038e100L;
    static final long GETTER_MIN = 0x0038e000L;
    static final long GETTER_MAX = 0x00390000L;

    JsonObject cfg;
    List<Map<String, Object>> cases = new ArrayList<>();
    List<String> getterOutputs = new ArrayList<>();
    int getterStatus;
    long getterWord;
    int getterCalls;
    int pollBridgeHits;
    long pollBridge;

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
            if (pc == pollBridge) pollBridgeHits++;
            if (pc == GETTER) {
                getterCalls++;
                long output = reg(e, "r0");
                getterOutputs.add(String.format("0x%08x", output));
                if (output < GETTER_MIN || output >= GETTER_MAX)
                    throw new IllegalStateException(String.format("native getter output pointer outside fixture interval: r0=0x%08x interval=[0x%08x,0x%08x)", output, GETTER_MIN, GETTER_MAX));
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
        getterOutputs.clear();
        e.writeRegister("r0", FRAME);
        int steps = execute(e, Long.decode(cfg.getAsJsonObject("addresses").get("console_response").getAsString()), EXIT);
        int result = (int)reg(e, "r0");
        byte[] reply = read(e, OUT + 12, 32);
        boolean pass = result == 32 && getterCalls == 0;
        if (present) {
            pass &= reply[0] == 0 && reply[1] == 1 && reply[2] == 1 && reply[3] == 1
                && be32(reply, 4) == 5 && be32(reply, 8) == 4 && be32(reply, 12) == 0
                && be32(reply, 16) == 0x87654321L && be32(reply, 20) == 0
                && be32(reply, 24) == 0 && be32(reply, 28) == 8;
        } else {
            pass &= reply[0] == 2 && reply[1] == 1 && reply[2] == 0 && reply[3] == 0
                && allZero(reply, 4, 32);
        }
        Map<String, Object> actual = new LinkedHashMap<>();
        actual.put("return", result);
        actual.put("reply_hex", hex(reply));
        actual.put("getter_calls", getterCalls);
        actual.put("getter_output_pointers", new ArrayList<>(getterOutputs));
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
        getterStatus = status;
        getterWord = word;
        getterCalls = 0;
        pollBridgeHits = 0;
        getterOutputs.clear();
        le32(e, GETTER_OUTPUT, 0xfeedfaceL);
        e.writeRegister("r0", GETTER_OUTPUT);
        int steps = execute(e, POLL_HOOK, POLL_CONT);
        int returned = (int)reg(e, "r0");
        long[] tail = new long[8];
        for (int i = 0; i < tail.length; i++) tail[i] = Integer.toUnsignedLong(value(e, OBJECT + 0x40 + 4L * i));
        boolean pass = returned == status && pollBridgeHits == 1 && getterCalls == 1
            && getterOutputs.equals(List.of(String.format("0x%08x", GETTER_OUTPUT)))
            && tail[0] == 2 && tail[1] == 1 && tail[2] == (status == 0 ? 1 : 0)
            && tail[3] == (status & 0xffffffffL) && tail[4] == (status == 0 ? word & 0xffffffffL : 0)
            && tail[5] == 0 && tail[6] == 0 && (tail[7] & 1) == (status == 0 ? 1 : 0);
        Map<String, Object> actual = new LinkedHashMap<>();
        actual.put("return", returned);
        actual.put("poll_bridge_hits", pollBridgeHits);
        actual.put("getter_calls", getterCalls);
        actual.put("getter_output_pointers", new ArrayList<>(getterOutputs));
        actual.put("tail_words_le32", tail);
        actual.put("fixture_getter_output_interval", "[0x0038e000,0x00390000)");
        add(status == 0 ? "poll-bridge-success" : "poll-bridge-failure", pass,
            "exact SYS poll hook reaches pinned bridge once; one getter fixture call updates telemetry tail",
            actual, steps, getterCalls);
        e.dispose();
    }

    void verifyImage() throws Exception {
        byte[] image = Files.readAllBytes(Path.of(cfg.get("image").getAsString()));
        String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(image));
        if (!sha.equals(cfg.get("image_sha256").getAsString())) throw new IllegalStateException("pinned candidate SYS SHA mismatch");
        if (image.length != cfg.get("image_bytes").getAsInt()) throw new IllegalStateException("pinned candidate SYS byte count mismatch");
        byte[] imported = new byte[image.length];
        currentProgram.getMemory().getBytes(toAddr(IMAGE_BASE), imported);
        if (!Arrays.equals(image, imported)) throw new IllegalStateException("Ghidra imported bytes differ from exact candidate SYS");
    }

    @Override public void run() throws Exception {
        Path receiptPath = Path.of(getScriptArgs()[1]);
        try {
            cfg = JsonParser.parseString(Files.readString(Path.of(getScriptArgs()[0]))).getAsJsonObject();
            verifyImage();
            JsonObject addresses = cfg.getAsJsonObject("addresses");
            pollBridge = Long.decode(addresses.get("poll_bridge").getAsString());
            snapshotCase(false);
            snapshotCase(true);
            pollCase(0, 0x87654321L);
            pollCase(-5, 0xdeadbeefL);
            long failed = cases.stream().filter(c -> !"passed".equals(c.get("status"))).count();
            Map<String, Object> receipt = new LinkedHashMap<>();
            receipt.put("status", failed == 0 ? "passed_exact_image_instruction_fixtures" : "failed_exact_image_instruction_fixtures");
            receipt.put("image_import_verified", true);
            receipt.put("image_sha256", cfg.get("image_sha256").getAsString());
            receipt.put("image_bytes", cfg.get("image_bytes").getAsInt());
            receipt.put("reference_artifacts", cfg.getAsJsonObject("reference_artifacts"));
            receipt.put("candidate_elf_sha256", null);
            receipt.put("scope", "Exactly four cases on the exact imported 393993 decoded SYS: F11A absent/present snapshot response and native poll hook success/failure. The F11A cases enter at the console630_response wrapper symbol 0x01128bf4; they do not exercise the original F11A ingress/parser path. No constructors, parser/response forwarding matrix, or code0-code7 cases are run here.");
            receipt.put("fallback_boundary", "The two 393993 wrapper fallback BSRs at 0x01128cfc and 0x01128db4 are byte-pinned as part of exact candidate identity, but this four-case run does not claim to execute them. Their mux paths have separate exact-image evidence.");
            receipt.put("boundary", "Fixture RAM only. The exact imported candidate instructions execute. At the single native getter boundary 0x0101fb68, one configured r0 output pointer/status/word is modeled for each poll case. No other ROM instruction fetch is modeled. This does not establish DSP semantics, live RAM, timing, boot order, installation, or physical hardware behavior.");
            receipt.put("cases", cases);
            Files.createDirectories(receiptPath.getParent());
            Files.writeString(receiptPath, new GsonBuilder().setPrettyPrinting().create().toJson(receipt) + "\n");
            println("Wrote four-case exact-image receipt " + receiptPath + "; failed=" + failed);
        } catch (Exception ex) {
            Map<String, Object> receipt = new LinkedHashMap<>();
            receipt.put("status", "blocked_or_failed_exact_instruction_execution");
            if (cfg != null) {
                receipt.put("image_sha256", cfg.get("image_sha256").getAsString());
                receipt.put("reference_artifacts", cfg.getAsJsonObject("reference_artifacts"));
            }
            receipt.put("candidate_elf_sha256", null);
            receipt.put("error", ex.toString());
            receipt.put("cases", cases);
            Files.createDirectories(receiptPath.getParent());
            Files.writeString(receiptPath, new GsonBuilder().setPrettyPrinting().create().toJson(receipt) + "\n");
            println("FAIL exact-instruction gate: " + ex);
        }
    }
}
