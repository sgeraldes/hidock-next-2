/**
 * @hidock/jensen-protocol — transport-agnostic Jensen USB protocol for HiDock devices.
 *
 * The protocol logic is identical across environments; only the WebUSB backend
 * differs. Inject `navigator.usb` (browser) or `new WebUSB()` from the node `usb`
 * package (Electron main / Node) into the JensenDevice constructor.
 */

export {
  JensenDevice,
  setJensenLogging,
  CMD,
  USB_VENDOR_ID,
  USB_ALTERNATE_VENDOR_ID,
  USB_VENDOR_IDS,
  USB_PRODUCT_IDS,
  EP_OUT,
  EP_IN,
  parseRealtimePayload,
  supportsRealtimeFirmware,
  calculateDurationSeconds,
  parseNativeRecordingStatusPayload,
  parseNativeRecordingCommandAck,
} from './jensen-device.js'

export type {
  DeviceModel,
  DeviceInfo,
  ProtocolFaultCode,
  ProtocolDiagnosticEvent,
  ProtocolDiagnostics,
  FileInfo,
  FileListingResult,
  FileRangeResult,
  FileListingPageResult,
  CardInfo,
  DeviceSettings,
  RealtimeSettings,
  RealtimeData,
  BatteryStatus,
  BluetoothDevice,
  BluetoothStatus,
  NativeRecordingStatus,
  NativeRecordingCommandAck,
  FirmwareBootExpectation,
  FirmwareBootVerification,
} from './jensen-device.js'

export {
  CUSTOM_RECORDING_PROFILE_GET,
  CUSTOM_RECORDING_PROFILE_SET,
  CUSTOM_RECORDING_BITRATES,
  encodeCustomRecordingProfile,
  parseCustomRecordingProfile,
  parseCustomRecordingProfileResponse,
} from './custom-recording-profile.js'
export type { CustomRecordingProfile, CustomRecordingProfileResponse } from './custom-recording-profile.js'
export { CUSTOM_RECORDING_FORMAT_GET, CUSTOM_RECORDING_FORMAT_SET, encodeCustomRecordingFormat, parseCustomRecordingFormat, parseCustomRecordingFormatResponse } from './custom-recording-format.js'
export type { CustomRecordingFormat, CustomRecordingFormatResponse } from './custom-recording-format.js'
export { CUSTOM_MARKER_RULES_GET, CUSTOM_MARKER_RULES_SET, encodeCustomMarkerRules, parseCustomMarkerRules, parseCustomMarkerRulesResponse } from './custom-marker-rules.js'
export type { CustomMarkerRules, CustomMarkerRulesResponse } from './custom-marker-rules.js'
export { REALTIME_CHANNEL_METADATA_BYTES, REALTIME_CHANNEL_FRAME_BYTES, REALTIME_CHANNEL_SAMPLE_RATE_HZ, REALTIME_CHANNEL_IDS, splitRealtimeChannelsTap } from './realtime-channels.js'
export type { RealtimeChannelId, RealtimeChannelPcm, RealtimeChannelsTap } from './realtime-channels.js'
export { FIRMWARE_CONSOLE_STATUS, FIRMWARE_CONSOLE_MAX_RESPONSE_BYTES, FIRMWARE_CONSOLE_REQUESTS,
  isFirmwareConsoleRequest, encodeFirmwareConsoleRequest, parseFirmwareConsoleStatus } from './firmware-console.js'
export type { FirmwareConsoleRequest, FirmwareConsoleStatus } from './firmware-console.js'
export { NATIVE_VAD_OBSERVATION_CANDIDATE_COMMAND, NATIVE_VAD_OBSERVATION_CANDIDATE_REPLY_BYTES,
  encodeNativeVadObservationCandidateRequest, parseNativeVadObservationCandidateReply } from './native-vad-observation.js'
export type { NativeVadObservationCandidate } from './native-vad-observation.js'
export { OWNED_SCRATCH_UPLOAD_COMMAND, OWNED_SCRATCH_MAX_BYTES, OWNED_SCRATCH_MAX_CHUNK_BYTES, ownedScratchCrc32,
  ownedScratchFilename, isOwnedScratchUploadDescriptor, encodeOwnedScratchUpload, isOwnedScratchStatusBody, parseOwnedScratchUploadReply } from './owned-scratch-upload.js'
export type { OwnedScratchUploadDescriptor, OwnedScratchUploadSession, OwnedScratchUploadOperation, OwnedScratchUploadRequest,
  OwnedScratchUploadState, OwnedScratchUploadReply, OwnedScratchWriteOptions, OwnedScratchWriteOutcome } from './owned-scratch-upload.js'
export { RECORDING_RESTORE_COMMAND, RECORDING_RESTORE_MAX_BYTES, RECORDING_RESTORE_VERSION, isRecordingRestoreFilename,
  isRecordingRestoreDescriptor, copyRecordingRestoreDescriptor, encodeRecordingRestore, parseRecordingRestoreCapabilities,
  isRecordingRestoreReadOnlyBody, parseRecordingRestoreReply } from './recording-restore.js'
export type { RecordingRestoreDescriptor, RecordingRestoreSession, RecordingRestoreOperation, RecordingRestoreRequest,
  RecordingRestoreCapabilities, RecordingRestoreReply, RecordingRestoreWriteOptions, RecordingRestoreWriteOutcome } from './recording-restore.js'
export { ACCEPTED_H1E_FIRMWARE, ACCEPTED_H1E_FORWARD_STOCK_RESTORE, ACCEPTED_H1E_OFFICIAL_RESTORE, isOrdinaryH1eVersion, permitsFirmwareVersion, parseFirmwareImage, copyFirmwareUploadArtifact, matchesAcceptedFirmwareImage, MAX_FIRMWARE_IMAGE_BYTES, parseFirmwareUpdateCard, isFirmwareUpdateCardReady, encodeFirmwareUpgradeRequest, parseFirmwareUpgradeAck, parseFirmwareUploadAck } from './firmware-update.js'
export type { FirmwareUpdateCard, FirmwareUpdatePreflight, FirmwareUpdatePreflightFailure, FirmwareUploadArtifact, FirmwareUploadSession, FirmwareUploadResult, FirmwareUploadFence, FirmwareImageMetadata } from './firmware-update.js'
