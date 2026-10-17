// @category HiDock
// Four bounded CK802 fixtures against the exact 393998 VoiceEnergy import fixture.
// This script does not build firmware or access hardware.
import ghidra.app.emulator.EmulatorHelper;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Instruction;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;
import com.google.gson.*;

public class VoiceEnergyV2ExactInstructionGate extends BoundedNativeContract630 {
    static final long IMAGE_BASE = 0x01000000L;
    static final long IMAGE_BYTES = 1275904L;
    static final String IMAGE_SHA = "cef21b2dfcb4c8efc6666a08034414a385851404e56fff8329bb7ff587669482";
    static final String RECEIPT_SHA = "e6d16935bcbc1d5a323a6b8de3b9ecfc994a197478afa5028f689e6104c0ea4d";

    static final long SLOT = 0x000852c0L;
    static final long PENDING = 0x000855dcL;
    static final long FRAGMENT = 0x000855ccL;
    static final long REF_GETTER = 0x0101fb68L;
    static final long ENERGY_GETTER = 0x0101fa9cL;
    static final long POLL_HOOK = 0x01020b62L;
    static final long POLL_STOP = 0x01020b66L;
    static final long PARSER_CONTINUATION = 0x0103b50aL;
    static final long PARSER_WRAPPER = 0x01128e4cL;
    static final long PARSER_CALL = 0x01128e68L;
    static final long PARSER_SHIM = 0x011372f8L;
    static final long RESPONSE_WRAPPER = 0x01128e94L;
    static final long RESPONSE_CONTINUATION = 0x010394e2L;
    static final long RESPONSE_CALL = 0x01128ea2L;
    static final long RESPONSE_SHIM = 0x01137350L;
    static final long POLL_BRIDGE = 0x0113718cL;
    static final long EXIT = 0x003ff000L;

    static final long FRAME = 0x00300000L;
    static final long HEAD = 0x00301000L;
    static final long CONTEXT = 0x00302000L;
    static final long BODY = 0x00303000L;
    static final long OUTPUT = 0x00304000L;
    static final long OBJECT = 0x00330000L;
    static final long GETTER_OUTPUT = 0x0038e100L;
    static final long GETTER_MIN = 0x0038e000L;
    static final long GETTER_MAX = 0x00390000L;

    static final long[] GUARD_ADDR = {0x00080e70L, 0x000852a4L, 0x00085290L, 0x00080e88L};
    static final long[] GUARD_VALUE = {0x0101f0ecL, 0x0101f93aL, 0x0101fa78L, 4L};
    static final long[] OBJECT_CANARY = {0x0032fff0L, 0x00330080L};

    static final class NativePlan {
        final long status;
        final long word;
        int calls;
        final List<String> pointers = new ArrayList<>();
        NativePlan(long s, long w) { status = s; word = w; }
    }
    interface CaseBody { Map<String, Object> run() throws Exception; }

    final List<Map<String, Object>> cases = new ArrayList<>();
    final List<String> trace = new ArrayList<>();
    final Map<Long, NativePlan> nativePlans = new HashMap<>();
    Path imagePath;
    Path fixtureReceiptPath;
    Path caseReceiptPath;
    boolean wholeImportByteEqual = false;
    boolean pinnedImageAndBranchGatePassed = false;
    int parserCallSiteHits;
    int responseCallSiteHits;
    int pollBridgeHits;
    int parserShimHits;
    int responseShimHits;

    long reg(EmulatorHelper e, String name) { return e.readRegister(name).longValue() & 0xffffffffL; }
    void le32(EmulatorHelper e, long at, long v) throws Exception { e.writeMemoryValue(toAddr(at), 4, v & 0xffffffffL); }
    void le16(EmulatorHelper e, long at, long v) throws Exception { e.writeMemoryValue(toAddr(at), 2, v & 0xffffL); }
    void le8(EmulatorHelper e, long at, int v) throws Exception { e.writeMemoryValue(toAddr(at), 1, v & 0xff); }
    void put(EmulatorHelper e, long at, byte[] b) throws Exception { e.writeMemory(toAddr(at), b); }
    byte[] read(EmulatorHelper e, long at, int n) throws Exception { return e.readMemory(toAddr(at), n); }
    String hex(byte[] b) { return HexFormat.of().formatHex(b); }
    String sha(byte[] b) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b)); }
    byte[] fill(int n, int value) { byte[] b = new byte[n]; Arrays.fill(b, (byte)value); return b; }
    void require(boolean ok, String message) { if (!ok) throw new IllegalStateException(message); }

    EmulatorHelper fresh() throws Exception {
        EmulatorHelper e = new EmulatorHelper(currentProgram);
        for (int i = 0; i < 14; i++) e.writeRegister("r" + i, 0);
        e.writeRegister("sp", 0x0038f000L);
        e.writeRegister("lr", EXIT);
        e.writeRegister("psr", 0x40L);
        e.writeMemory(toAddr(0x002ff000L), new byte[0x6000]);
        e.writeMemory(toAddr(0x0032f000L), new byte[0x2000]);
        e.writeMemory(toAddr(0x0038e000L), new byte[0x2000]);
        le32(e, SLOT, 0);
        le16(e, PENDING, 0);
        le8(e, FRAGMENT, 0);
        for (int i = 0; i < GUARD_ADDR.length; i++) le32(e, GUARD_ADDR[i], GUARD_VALUE[i]);
        return e;
    }

    long u32(EmulatorHelper e, long at) throws Exception { return Integer.toUnsignedLong(value(e, at)); }
    long[] words(EmulatorHelper e, long at, int count) throws Exception {
        long[] out = new long[count];
        for (int i = 0; i < count; i++) out[i] = u32(e, at + 4L * i);
        return out;
    }
    long[] seedV2Cache(EmulatorHelper e, long[] initial) throws Exception {
        for (int i = 0; i < initial.length; i++) le32(e, OBJECT + 0x60 + 4L * i, initial[i]);
        return initial;
    }
    void seedObject(EmulatorHelper e, long nativeState, long[] telemetry, long[] cache) throws Exception {
        put(e, OBJECT - 16, fill(16, 0xa5));
        put(e, OBJECT, fill(0x80, 0));
        put(e, OBJECT + 0x80, fill(16, 0xa5));
        le8(e, OBJECT, (int)nativeState);
        le32(e, SLOT, OBJECT);
        if (telemetry != null) for (int i = 0; i < telemetry.length; i++) le32(e, OBJECT + 0x40 + 4L * i, telemetry[i]);
        if (cache != null) seedV2Cache(e, cache);
    }
    void seedF11aParse(EmulatorHelper e) throws Exception {
        put(e, FRAME, fill(0x180, 0));
        put(e, HEAD, fill(16, 0));
        put(e, CONTEXT, fill(32, 0));
        put(e, BODY, new byte[]{2});
        le32(e, FRAME + 0x14, HEAD);
        le32(e, FRAME + 0x1c, CONTEXT);
        // Existing parser ABI reads the command from head[2..3] big-endian.
        le8(e, HEAD + 2, 0xf1);
        le8(e, HEAD + 3, 0x1a);
        be32(e, HEAD + 8, 1);
        le16(e, PENDING, 0xf11a);
        le8(e, FRAGMENT, 0);
    }
    void seedF11aResponse(EmulatorHelper e, int savedState) throws Exception {
        put(e, FRAME, fill(0x180, 0));
        put(e, HEAD, fill(16, 0));
        put(e, OUTPUT, fill(64, 0xcc));
        le32(e, FRAME + 0x18, 0xf11a);
        le32(e, FRAME + 0x1c, OUTPUT);
        le32(e, FRAME + 0x20, 32);
        le32(e, FRAME + 0x28, HEAD);
        le8(e, HEAD + 2, 0xf1);
        le8(e, HEAD + 3, 0x1a);
        le8(e, HEAD + 8, 0);
        le8(e, HEAD + 9, savedState);
    }
    void be32(EmulatorHelper e, long at, long v) throws Exception {
        e.writeMemoryValue(toAddr(at), 4,
            ((v & 0xffL) << 24) | ((v & 0xff00L) << 8) | ((v >>> 8) & 0xff00L) | ((v >>> 24) & 0xffL));
    }
    long be32(byte[] b, int at) {
        return ((long)(b[at] & 0xff) << 24) | ((long)(b[at + 1] & 0xff) << 16) |
               ((long)(b[at + 2] & 0xff) << 8) | (b[at + 3] & 0xffL);
    }

    void resetTrace() {
        trace.clear(); nativePlans.clear();
        parserCallSiteHits = responseCallSiteHits = pollBridgeHits = parserShimHits = responseShimHits = 0;
    }
    void nativePlan(long address, long status, long word) { nativePlans.put(address, new NativePlan(status, word)); }
    int execute(EmulatorHelper e, long entry, long stop) throws Exception {
        e.writeRegister("pc", entry);
        int steps = 0;
        long start = System.nanoTime();
        trace.add(String.format("entry=0x%08x stop=0x%08x", entry, stop));
        while (e.getExecutionAddress().getOffset() != stop) {
            if (++steps > 180000 || System.nanoTime() - start > 20_000_000_000L)
                throw new IllegalStateException("bounded step/time limit at " + e.getExecutionAddress());
            long pc = e.getExecutionAddress().getOffset();
            if (pc == PARSER_CALL) { parserCallSiteHits++; trace.add("parser_callsite=0x01128e68"); }
            if (pc == RESPONSE_CALL) { responseCallSiteHits++; trace.add("response_callsite=0x01128ea2"); }
            if (pc == POLL_BRIDGE) { pollBridgeHits++; trace.add("poll_bridge=0x0113718c"); }
            if (pc == PARSER_SHIM) { parserShimHits++; trace.add("parser_shim=0x011372f8"); }
            if (pc == RESPONSE_SHIM) { responseShimHits++; trace.add("response_shim=0x01137350"); }
            NativePlan plan = nativePlans.get(pc);
            if (plan != null) {
                long output = reg(e, "r0");
                plan.calls++;
                plan.pointers.add(String.format("0x%08x", output));
                trace.add(String.format("native_boundary=0x%08x r0=0x%08x status=%d word=0x%08x", pc, output, plan.status, plan.word));
                if (output < GETTER_MIN || output >= GETTER_MAX || (output & 3) != 0)
                    throw new IllegalStateException(String.format("native output range/alignment failure at 0x%08x: r0=0x%08x interval=[0x%08x,0x%08x)", pc, output, GETTER_MIN, GETTER_MAX));
                le32(e, output, plan.word);
                e.writeRegister("r0", plan.status & 0xffffffffL);
                e.writeRegister("pc", reg(e, "lr"));
                continue;
            }
            if (pc < IMAGE_BASE || pc >= IMAGE_BASE + IMAGE_BYTES)
                throw new IllegalStateException(String.format("unmodeled instruction fetch outside exact fixture: pc=0x%08x", pc));
            step(e);
        }
        return steps;
    }

    byte[] at(byte[] image, long address, int n) {
        int start = Math.toIntExact(address - IMAGE_BASE);
        return Arrays.copyOfRange(image, start, start + n);
    }
    void checkCallSite(byte[] image, long site, String bytes, long target) throws Exception {
        require(hex(at(image, site, 4)).equals(bytes), String.format("patch bytes mismatch at 0x%08x", site));
        Instruction ins = getInstructionAt(toAddr(site));
        if (ins == null) { disassemble(toAddr(site)); ins = getInstructionAt(toAddr(site)); }
        require(ins != null, String.format("undecoded callsite 0x%08x", site));
        require(ins.getMnemonicString().toLowerCase(Locale.ROOT).startsWith("bsr"), "patch site is not BSR: " + ins);
        Address[] flows = ins.getFlows();
        boolean reaches = false;
        if (flows != null) for (Address flow : flows) if (flow.getOffset() == target) reaches = true;
        require(reaches, String.format("BSR at 0x%08x did not decode to 0x%08x: %s flows=%s", site, target, ins, Arrays.toString(flows)));
        trace.add(String.format("verified_bsr=0x%08x bytes=%s target=0x%08x", site, bytes, target));
    }
    void checkWrapperEntry(long address, String role) throws Exception {
        Instruction ins = getInstructionAt(toAddr(address));
        if (ins == null) { disassemble(toAddr(address)); ins = getInstructionAt(toAddr(address)); }
        require(ins != null, role + " outer wrapper entry is undecodable");
        require(ins.getMnemonicString().equalsIgnoreCase("push"), role + " did not enter the outer assembly wrapper: " + ins);
    }
    void verifyImage() throws Exception {
        byte[] image = Files.readAllBytes(imagePath);
        require(image.length == IMAGE_BYTES, "fixture size mismatch: " + image.length);
        require(sha(image).equals(IMAGE_SHA), "fixture image SHA mismatch: " + sha(image));
        byte[] imported = new byte[image.length];
        currentProgram.getMemory().getBytes(toAddr(IMAGE_BASE), imported);
        require(Arrays.equals(image, imported), "Ghidra imported bytes differ from exact emulator fixture");
        wholeImportByteEqual = true;

        byte[] receipt = Files.readAllBytes(fixtureReceiptPath);
        require(sha(receipt).equals(RECEIPT_SHA), "fixture receipt SHA mismatch: " + sha(receipt));
        JsonObject json = JsonParser.parseString(new String(receipt, java.nio.charset.StandardCharsets.UTF_8)).getAsJsonObject();
        require("EMULATOR_IMPORT_ONLY_NOTINSTALL".equals(json.get("status").getAsString()), "fixture status is not emulator-only/not-install");
        require(!json.get("installable").getAsBoolean(), "fixture unexpectedly marked installable");
        require(json.getAsJsonObject("output").get("sha256").getAsString().equals(IMAGE_SHA), "receipt image pin mismatch");
        require(json.getAsJsonObject("inverse_reconstruction").get("verified_byte_identical_to_input").getAsBoolean(), "fixture inverse reconstruction is not byte-identical");

        JsonObject sections = json.getAsJsonArray("allocated_sections_applied").get(5).getAsJsonObject();
        require(sections.get("address").getAsString().equals("0x01137000") && sections.get("size_bytes").getAsInt() == 1232,
                "fixture VoiceEnergy text range mismatch");
        require(sha(at(image, 0x01137000L, 1232)).equals("9e0a12cccba8ab6fedd5287d03beb9e7af32167ea055f3353a577fe576735889"), "VoiceEnergy text section hash mismatch");
        require(sha(at(image, 0x011374d0L, 21)).equals("fcce046ce09d84c841da0201ff666c7db76a048790a4c5855998668b2780e03d"), "VoiceEnergy rodata section hash mismatch");

        checkCallSite(image, POLL_HOOK, "08e015b3", POLL_BRIDGE);
        checkCallSite(image, PARSER_CALL, "00e04872", PARSER_SHIM);
        checkCallSite(image, RESPONSE_CALL, "00e05772", RESPONSE_SHIM);
        require(hex(at(image, 0x01021054L, 2)).equals("8030"), "128-byte allocation instruction pin mismatch");
        require(hex(at(image, 0x0102109eL, 2)).equals("8032"), "128-byte clear instruction pin mismatch");
        checkWrapperEntry(PARSER_WRAPPER, "parser");
        checkWrapperEntry(RESPONSE_WRAPPER, "response");
        pinnedImageAndBranchGatePassed = true;
        require(!trace.isEmpty(), "static instruction-pinning trace missing");
        println("Verified exact emulator-only fixture SHA, size, image import, retained sections, and three BSR destinations.");
    }

    void caseRun(String id, CaseBody body) {
        resetTrace();
        try {
            Map<String, Object> detail = body.run();
            boolean pass = Boolean.TRUE.equals(detail.get("pass"));
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", id);
            row.put("status", pass ? "passed_exact_fixture_case" : "failed_exact_fixture_case");
            row.put("detail", detail);
            row.put("instruction_trace", new ArrayList<>(trace));
            cases.add(row);
            println(id + " " + (pass ? "PASS" : "FAIL") + " actual=" + detail);
        } catch (Exception ex) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", id); row.put("status", "failed_exact_fixture_case");
            row.put("error", ex.toString()); row.put("instruction_trace", new ArrayList<>(trace));
            cases.add(row);
            println(id + " FAIL " + ex);
        }
    }
    Map<String, Object> result(boolean pass, Object expected, Object actual) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("pass", pass); m.put("expected", expected); m.put("actual", actual);
        return m;
    }
    void seedCanaries(EmulatorHelper e) throws Exception {
        put(e, OBJECT_CANARY[0], fill(16, 0xa5));
        put(e, OBJECT_CANARY[1], fill(16, 0xa5));
    }
    boolean canariesIntact(EmulatorHelper e) throws Exception {
        return Arrays.equals(read(e, OBJECT_CANARY[0], 16), fill(16, 0xa5)) &&
               Arrays.equals(read(e, OBJECT_CANARY[1], 16), fill(16, 0xa5));
    }
    boolean outputTailIntact(EmulatorHelper e) throws Exception { return Arrays.equals(read(e, OUTPUT + 44, 20), fill(20, 0xcc)); }
    Map<String, Object> snapshot(long energyStatus, long energyWord, long[] initialCache, boolean parseV2) throws Exception {
        EmulatorHelper e = fresh();
        try {
            seedCanaries(e);
            seedObject(e, 1, new long[8], initialCache);
            nativePlan(REF_GETTER, 0, 0x01020304L);
            nativePlan(ENERGY_GETTER, energyStatus, energyWord);
            int parserSteps = 0;
            boolean parsed = true;
            if (parseV2) {
                seedF11aParse(e);
                e.writeRegister("sp", FRAME);
                e.writeRegister("lr", EXIT);
                e.writeRegister("r0", 0); e.writeRegister("r1", 0); e.writeRegister("r2", 0); e.writeRegister("r3", 0);
                e.writeRegister("r4", 1); e.writeRegister("r5", BODY);
                parserSteps = execute(e, PARSER_WRAPPER, PARSER_CONTINUATION);
                parsed = parserCallSiteHits == 1 && parserShimHits == 1 && (read(e, HEAD + 8, 1)[0] & 0xff) == 0 &&
                         (read(e, HEAD + 9, 1)[0] & 0xff) == 2 && (read(e, BODY, 1)[0] & 0xff) == 2;
            }
            e.writeRegister("sp", 0x0038f000L); e.writeRegister("lr", EXIT);
            e.writeRegister("r0", GETTER_OUTPUT);
            int pollSteps = execute(e, POLL_HOOK, POLL_STOP);
            long pollStatus = reg(e, "r0");
            long[] vadt = words(e, OBJECT + 0x40, 8);
            long[] cache = words(e, OBJECT + 0x60, 8);
            seedF11aResponse(e, 2);
            e.writeRegister("sp", FRAME); e.writeRegister("lr", EXIT); e.writeRegister("r0", 0);
            int responseSteps = execute(e, RESPONSE_WRAPPER, RESPONSE_CONTINUATION);
            byte[] reply = read(e, OUTPUT + 12, 32);
            long storedLength = u32(e, FRAME + 128);
            boolean noOutputOverflow = outputTailIntact(e);
            boolean noCanaryWrite = canariesIntact(e);
            NativePlan ref = nativePlans.get(REF_GETTER);
            NativePlan energy = nativePlans.get(ENERGY_GETTER);
            boolean calls = ref != null && energy != null && ref.calls == 1 && energy.calls == 1 &&
                ref.pointers.equals(List.of("0x0038e100")) && energy.pointers.size() == 1;
            boolean pollOk = pollBridgeHits == 1 && pollStatus == 0;
            boolean cacheOk;
            String expectedHex;
            if (energyStatus == 0) {
                expectedHex = "0002010000000001000000010000000087654321000000020000000000000000";
                cacheOk = Arrays.equals(cache, new long[]{2, 1, 1, 0, 0x87654321L, 1, 0, 0});
            } else {
                expectedHex = "0002010000000006000000030000000111223344000000080000000000000000";
                cacheOk = Arrays.equals(cache, new long[]{8, 6, 3, 1, 0x11223344L, 1, 0, 0});
            }
            boolean responseOk = responseCallSiteHits == 1 && responseShimHits == 1 && storedLength == 32 && hex(reply).equals(expectedHex);
            boolean overflowOk = noOutputOverflow && noCanaryWrite;
            Map<String, Object> actual = new LinkedHashMap<>();
            actual.put("parser_pass", parsed); actual.put("poll_status", pollStatus); actual.put("poll_bridge_hits", pollBridgeHits);
            actual.put("native_getter_calls", Map.of("RefChannelVAD", ref == null ? 0 : ref.calls, "VoiceEnergy", energy == null ? 0 : energy.calls));
            actual.put("native_output_pointers", Map.of("RefChannelVAD", ref == null ? List.of() : ref.pointers, "VoiceEnergy", energy == null ? List.of() : energy.pointers));
            actual.put("vadt_words_le32", vadt); actual.put("energy_cache_words_le32", cache); actual.put("reply_hex", hex(reply));
            actual.put("outer_response_saved_length", storedLength); actual.put("response_shim_hits", responseShimHits);
            actual.put("response_output_tail_intact", noOutputOverflow); actual.put("object_canaries_intact", noCanaryWrite);
            actual.put("executed_instructions", Map.of("parser", parserSteps, "poll", pollSteps, "response", responseSteps));
            actual.put("proven_entrypoints", parseV2 ? List.of("assembly parser wrapper 0x01128e4c -> handled continuation 0x0103b50a", "poll hook 0x01020b62 -> 0x01020b66", "assembly response wrapper 0x01128e94 -> handled continuation 0x010394e2") : List.of("poll hook 0x01020b62 -> 0x01020b66", "assembly response wrapper 0x01128e94 -> handled continuation 0x010394e2"));
            boolean pass = parsed && calls && pollOk && cacheOk && responseOk && overflowOk;
            return result(pass, Map.of("cache_words", energyStatus == 0 ? new long[]{2,1,1,0,0x87654321L,1,0,0} : new long[]{8,6,3,1,0x11223344L,1,0,0}, "reply_hex", expectedHex, "one call at each modeled getter", "r0 output pointers aligned in [0x0038e000,0x00390000)"), actual);
        } finally { e.dispose(); }
    }

    Map<String, Object> absentV2() throws Exception {
        EmulatorHelper e = fresh();
        try {
            seedCanaries(e); seedF11aResponse(e, 2);
            nativePlans.clear();
            e.writeRegister("sp", FRAME); e.writeRegister("lr", EXIT); e.writeRegister("r0", 0);
            int steps = execute(e, RESPONSE_WRAPPER, RESPONSE_CONTINUATION);
            byte[] reply = read(e, OUTPUT + 12, 32);
            long length = u32(e, FRAME + 128);
            boolean pass = responseCallSiteHits == 1 && responseShimHits == 1 && length == 32 &&
                hex(reply).equals("0202000000000000000000000000000000000000000000000000000000000000") &&
                outputTailIntact(e) && canariesIntact(e) && nativePlans.isEmpty();
            Map<String, Object> actual = new LinkedHashMap<>(); actual.put("reply_hex", hex(reply)); actual.put("stored_length", length);
            actual.put("response_shim_hits", responseShimHits); actual.put("modeled_getter_calls", 0); actual.put("executed_instructions", steps);
            actual.put("entrypoint", "assembly response wrapper 0x01128e94; patched BSR at 0x01128ea2; stop at handled continuation 0x010394e2");
            return result(pass, "return size 32, v2 unavailable snapshot, no modeled native getter call", actual);
        } finally { e.dispose(); }
    }
    Map<String, Object> v1Passthrough() throws Exception {
        EmulatorHelper e = fresh();
        try {
            seedCanaries(e);
            seedObject(e, 1, new long[]{2,1,1,0,0x13579bdfL,0,0,1},
                new long[]{0xa5a5a5a5L,0xa5a5a5a5L,0xa5a5a5a5L,0xa5a5a5a5L,
                           0xa5a5a5a5L,0xa5a5a5a5L,0xa5a5a5a5L,0xa5a5a5a5L});
            seedF11aResponse(e, 1);
            long[] sidecarBefore = words(e, OBJECT + 0x60, 8);
            nativePlans.clear();
            e.writeRegister("sp", FRAME); e.writeRegister("lr", EXIT); e.writeRegister("r0", 0);
            int steps = execute(e, RESPONSE_WRAPPER, RESPONSE_CONTINUATION);
            byte[] reply = read(e, OUTPUT + 12, 32);
            long length = u32(e, FRAME + 128);
            long[] sidecarAfter = words(e, OBJECT + 0x60, 8);
            boolean pass = responseCallSiteHits == 1 && responseShimHits == 1 && length == 32 &&
                hex(reply).equals("0001010100000001000000010000000013579bdf000000000000000000000002") &&
                Arrays.equals(sidecarBefore, sidecarAfter) && outputTailIntact(e) && canariesIntact(e) && nativePlans.isEmpty();
            Map<String, Object> actual = new LinkedHashMap<>(); actual.put("reply_hex", hex(reply)); actual.put("stored_length", length);
            actual.put("sidecar_before_le32", sidecarBefore); actual.put("sidecar_after_le32", sidecarAfter);
            actual.put("response_shim_hits", responseShimHits); actual.put("modeled_getter_calls", 0); actual.put("executed_instructions", steps);
            actual.put("entrypoint", "assembly response wrapper 0x01128e94; patched BSR at 0x01128ea2; stop at handled continuation 0x010394e2; v1 forwards to retained VAD response");
            return result(pass, "V1 payload byte-exact; sidecar/canaries unchanged; no getter calls or shim re-entry", actual);
        } finally { e.dispose(); }
    }

    void writeReceipt(String status, String failure) throws Exception {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schema", "hidock-vad-v2-exact-instruction-receipt/v1"); out.put("status", status);
        out.put("fixture_path", imagePath.toAbsolutePath().toString()); out.put("fixture_sha256", IMAGE_SHA); out.put("fixture_bytes", IMAGE_BYTES);
        out.put("fixture_receipt_path", fixtureReceiptPath.toAbsolutePath().toString()); out.put("fixture_receipt_sha256", RECEIPT_SHA);
        out.put("case_receipt_path", caseReceiptPath.toAbsolutePath().toString());
        out.put("fixture_status", "EMULATOR_IMPORT_ONLY_NOTINSTALL"); out.put("whole_import_byte_equal", wholeImportByteEqual);
        out.put("pinned_image_and_branch_gate_passed", pinnedImageAndBranchGatePassed);
        out.put("branch_targets", Map.of("0x01020b62", "0x0113718c", "0x01128e68", "0x011372f8", "0x01128ea2", "0x01137350"));
        out.put("cases", cases); out.put("hardware_usb_app_access", false); out.put("firmware_build_or_composition", false);
        out.put("failure", failure);
        out.put("scope", "Exactly four CK802 instruction fixtures on a read-only emulator import of the pinned NOTINSTALL image: one parser-selector-2 + poll + v2 success, one Energy status-1 failure preserving raw + v2 reply, one v2 response with no object, and one V1 passthrough. Synthetic RAM only; only native getter entrypoints 0x0101fb68 and 0x0101fa9c are modeled. Constructors are not executed. No claim about DSP, live target RAM, voice, freshness, or hardware.");
        Files.createDirectories(caseReceiptPath.getParent());
        Files.writeString(caseReceiptPath, new GsonBuilder().setPrettyPrinting().create().toJson(out) + "\n");
    }

    @Override public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 3) throw new IllegalArgumentException("expected exact fixture SYS path, input fixture receipt path, and separate QA receipt path");
        imagePath = Path.of(args[0]); fixtureReceiptPath = Path.of(args[1]); caseReceiptPath = Path.of(args[2]);
        String failure = null;
        try {
            resetTrace(); verifyImage();
            caseRun("poll_both_getters_success_then_v2_reply", () -> snapshot(0, 0x87654321L, new long[8], true));
            caseRun("energy_getter_status1_failure_preserves_previous_raw", () -> snapshot(1, 0xdeadbeefL, new long[]{6,5,3,0,0x11223344L,1,0,0}, false));
            caseRun("v2_response_without_object", this::absentV2);
            caseRun("f11a_v1_passthrough", this::v1Passthrough);
            long failed = cases.stream().filter(c -> !"passed_exact_fixture_case".equals(c.get("status"))).count();
            writeReceipt(failed == 0 ? "passed_four_exact_fixture_cases" : "failed_four_exact_fixture_cases", null);
            println("Four-case exact-image instruction gate complete; failed=" + failed);
            if (failed != 0) throw new IllegalStateException("one or more exact-image fixture cases failed; see receipt");
        } catch (Exception ex) {
            failure = ex.toString();
            writeReceipt("blocked_or_failed_exact_instruction_gate", failure);
            throw ex;
        }
    }
}
