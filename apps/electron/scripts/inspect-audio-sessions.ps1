param([string]$OutputPath)
$ErrorActionPreference = 'Stop'

# Read-only Core Audio snapshot. No IAudioClient stream, setters, default-endpoint
# changes, mute/volume calls, process termination or device commands are used.
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace HiDockReadOnlyAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumeratorClass { }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IDeviceCollection devices);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDevice {
    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object value);
    [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStore store);
    [PreserveSig] int GetId(out IntPtr value);
    [PreserveSig] int GetState(out uint state);
  }
  [ComImport, Guid("1BE09788-6894-4089-8586-9A2A6C265AC5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IEndpoint { [PreserveSig] int GetDataFlow(out int flow); }
  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid Format; public uint Id; }
  [StructLayout(LayoutKind.Explicit, Size=24)] struct PropVariant {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public IntPtr Pointer;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISessionManager2 {
    [PreserveSig] int GetAudioSessionControl(ref Guid session, uint flags, out IntPtr value);
    [PreserveSig] int GetSimpleAudioVolume(ref Guid session, uint flags, out IntPtr value);
    [PreserveSig] int GetSessionEnumerator(out ISessionEnumerator sessions);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out ISessionControl session);
  }
  [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISessionControl { [PreserveSig] int GetState(out int state); }

  public class EndpointResult {
    public int EndpointIndex;
    public string Flow = "unknown";
    public bool? HiDockNameMatch;
    public int? SessionCount;
    public int ActiveSessions;
    public int InactiveSessions;
    public int ExpiredSessions;
    public int UnknownSessions;
    public bool SessionEnumerationSucceeded;
    public List<string> Errors = new List<string>();
  }
  public class ProbeResult {
    public string Status = "unavailable";
    public string FailureStage;
    public string FailureHresult;
    public uint AvailableEndpointCount;
    public bool EndpointEnumerationSucceeded;
    public List<EndpointResult> Endpoints = new List<EndpointResult>();
  }
  public static class Probe {
    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved, uint flags);
    [DllImport("ole32.dll")] static extern void CoUninitialize();
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);
    static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
    static string Hr(int hr) { return "0x" + unchecked((uint)hr).ToString("X8"); }
    static bool Check(int hr, EndpointResult result, string stage) {
      if (hr >= 0) return true;
      result.Errors.Add(stage + ":" + Hr(hr)); return false;
    }
    static bool? MatchName(IDevice device, EndpointResult result) {
      IPropertyStore store = null;
      try {
        if (!Check(device.OpenPropertyStore(0, out store), result, "OpenPropertyStore")) return null;
        var key = new PropertyKey { Format = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), Id = 14 };
        PropVariant value;
        if (!Check(store.GetValue(ref key, out value), result, "GetFriendlyNameProperty")) return null;
        try {
          if (value.Type != 31 || value.Pointer == IntPtr.Zero) { result.Errors.Add("FriendlyNameTypeUnavailable"); return null; }
          // The endpoint name is read only to derive this heuristic, never emitted.
          string name = Marshal.PtrToStringUni(value.Pointer);
          return name != null && name.IndexOf("HiDock", StringComparison.OrdinalIgnoreCase) >= 0;
        } finally { PropVariantClear(ref value); }
      } catch (COMException error) { result.Errors.Add("FriendlyNameCOM:" + Hr(error.ErrorCode)); return null; }
      finally { Release(store); }
    }
    static ProbeResult Read() {
      var result = new ProbeResult();
      string stage = "InstantiateEnumerator";
      IDeviceEnumerator enumerator = null; IDeviceCollection devices = null;
      int initialized = CoInitializeEx(IntPtr.Zero, 0); // MTA, no UI thread.
      if (initialized < 0) { result.FailureStage = "CoInitializeExMTA"; result.FailureHresult = Hr(initialized); return result; }
      try {
        enumerator = (IDeviceEnumerator)new DeviceEnumeratorClass();
        stage = "EnumAudioEndpoints";
        int hr = enumerator.EnumAudioEndpoints(2, 1, out devices); // All flows, DEVICE_STATE_ACTIVE only.
        if (hr < 0) { result.FailureStage = "EnumAudioEndpoints"; result.FailureHresult = Hr(hr); return result; }
        uint count; hr = devices.GetCount(out count);
        if (hr < 0) { result.FailureStage = "EndpointGetCount"; result.FailureHresult = Hr(hr); return result; }
        result.AvailableEndpointCount = count;
        result.EndpointEnumerationSucceeded = true;
        result.Status = count <= 256 ? "observed" : "partial";
        for (uint index = 0; index < Math.Min(count, 256); index++) {
          var endpoint = new EndpointResult { EndpointIndex = (int)index };
          result.Endpoints.Add(endpoint);
          IDevice device = null; object activated = null; ISessionEnumerator sessions = null;
          try {
            if (!Check(devices.Item(index, out device), endpoint, "EndpointItem")) continue;
            int flow;
            if (Check(((IEndpoint)device).GetDataFlow(out flow), endpoint, "GetDataFlow")) endpoint.Flow = flow == 0 ? "render" : flow == 1 ? "capture" : "unknown";
            endpoint.HiDockNameMatch = MatchName(device, endpoint);
            var iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
            if (!Check(device.Activate(ref iid, 23, IntPtr.Zero, out activated), endpoint, "ActivateSessionManager2")) continue;
            var manager = (ISessionManager2)activated;
            if (!Check(manager.GetSessionEnumerator(out sessions), endpoint, "GetSessionEnumerator")) continue;
            int sessionCount;
            if (!Check(sessions.GetCount(out sessionCount), endpoint, "SessionGetCount")) continue;
            if (sessionCount < 0 || sessionCount > 4096) { endpoint.Errors.Add("SessionCountOutOfBounds"); continue; }
            endpoint.SessionCount = sessionCount;
            endpoint.SessionEnumerationSucceeded = true;
            for (int at = 0; at < sessionCount; at++) {
              ISessionControl session = null;
              try {
                if (!Check(sessions.GetSession(at, out session), endpoint, "GetSession")) { endpoint.UnknownSessions++; continue; }
                int state;
                if (!Check(session.GetState(out state), endpoint, "GetSessionState")) { endpoint.UnknownSessions++; continue; }
                if (state == 1) endpoint.ActiveSessions++;
                else if (state == 0) endpoint.InactiveSessions++;
                else if (state == 2) endpoint.ExpiredSessions++;
                else { endpoint.UnknownSessions++; endpoint.Errors.Add("SessionStateOutOfBounds"); }
              } finally { Release(session); }
            }
          } catch (COMException error) { endpoint.Errors.Add("EndpointCOM:" + Hr(error.ErrorCode)); }
          catch { endpoint.Errors.Add("EndpointInspectionUnavailable"); }
          finally { Release(sessions); Release(activated); Release(device); }
          if (endpoint.Errors.Count > 0) result.Status = "partial";
        }
        foreach (var endpoint in result.Endpoints) if (!endpoint.SessionEnumerationSucceeded || endpoint.Errors.Count > 0) result.Status = "partial";
        return result;
      } catch (COMException error) { result.FailureStage = "CoreAudioCOM"; result.FailureHresult = Hr(error.ErrorCode); return result; }
      catch (Exception error) { result.FailureStage = stage + ":" + error.GetType().Name; result.FailureHresult = Hr(error.HResult); return result; }
      finally { Release(devices); Release(enumerator); CoUninitialize(); }
    }
    public static ProbeResult Inspect() {
      ProbeResult result = null;
      var worker = new Thread(() => { result = Read(); });
      worker.IsBackground = true;
      worker.SetApartmentState(ApartmentState.MTA);
      worker.Start();
      if (!worker.Join(15000)) return new ProbeResult { FailureStage = "InspectionDeadline" };
      return result ?? new ProbeResult { FailureStage = "InspectionUnavailable" };
    }
  }
}
'@

$phase = 'Compile'
try {
  if (-not ('HiDockReadOnlyAudio.Probe' -as [type])) { Add-Type -TypeDefinition $source -ErrorAction Stop }
  $phase = 'ReadCoreAudio'
  $probe = [HiDockReadOnlyAudio.Probe]::Inspect()
  $phase = 'TransformPublicOutput'
  $endpoints = @($probe.Endpoints | ForEach-Object {
    [pscustomobject][ordered]@{ endpointIndex = $_.EndpointIndex; flow = $_.Flow; hiDockNameMatch = $_.HiDockNameMatch;
      sessionCount = $_.SessionCount; activeSessions = $_.ActiveSessions; inactiveSessions = $_.InactiveSessions;
      expiredSessions = $_.ExpiredSessions; unknownSessions = $_.UnknownSessions;
      sessionEnumerationSucceeded = $_.SessionEnumerationSucceeded; errors = @($_.Errors) }
  })
  $matched = @($endpoints | Where-Object hiDockNameMatch -eq $true)
  $result = [ordered]@{ schemaVersion = 1; observedAt = [DateTime]::UtcNow.ToString('o'); status = $probe.Status;
    boundary = 'Windows Core Audio read-only shared-mode session snapshot across all available capture/render endpoints';
    endpointEnumerationSucceeded = $probe.EndpointEnumerationSucceeded; availableEndpointCount = $probe.AvailableEndpointCount;
    endpoints = $endpoints; knownActiveSessionCount = ($endpoints | Measure-Object activeSessions -Sum).Sum;
    hiDockNameMatchedEndpointCount = $matched.Count; hiDockNameMatchedActiveSessionCount = ($matched | Measure-Object activeSessions -Sum).Sum;
    failureStage = $probe.FailureStage; failureHresult = $probe.FailureHresult;
    limitations = @('Endpoint availability is not stream activity', 'Friendly-name matching is a heuristic, not device identity attestation',
      'Exclusive-mode streams and physical audio activity are not established by this API', 'Sessions can change during or immediately after enumeration');
    operatorAudioQuiescenceProved = $false; audioSettingsChanged = $false; streamsStartedOrStopped = 0; deviceCommandsIssued = 0;
    endpointAndApplicationNamesEmitted = $false }
} catch {
  $result = [ordered]@{ schemaVersion = 1; observedAt = [DateTime]::UtcNow.ToString('o'); status = 'unavailable';
    failureStage = "ProbeSetupUnavailable:$phase"; failureType = $_.Exception.GetType().Name;
    operatorAudioQuiescenceProved = $false; audioSettingsChanged = $false;
    streamsStartedOrStopped = 0; deviceCommandsIssued = 0; endpointAndApplicationNamesEmitted = $false }
}
$json = $result | ConvertTo-Json -Depth 9
if ($OutputPath) {
  $evidenceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../research/rea/completion630-lab/application'))
  $destination = [IO.Path]::GetFullPath($OutputPath)
  if (-not $destination.StartsWith($evidenceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetDirectoryName($destination) -ne $evidenceRoot -or [IO.Path]::GetFileName($destination) -notmatch '^audio-session-inspection[-a-zA-Z0-9.]*\.json$' -or
    [IO.File]::Exists($destination)) { throw 'Audio inspection output must be a new scoped evidence JSON file' }
  [IO.Directory]::CreateDirectory($evidenceRoot) | Out-Null
  [IO.File]::WriteAllText($destination, $json, [Text.UTF8Encoding]::new($false))
}
$json
