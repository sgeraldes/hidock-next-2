/**
 * The harness descriptors as plain data for the shared validation and the Pipeline page.
 */
import { listHarnessDescriptors, type HarnessDescriptor } from '../brains'
import type { EffortLevel, HarnessInfo } from '../../../../src/shared/pipeline-config'

export function toHarnessInfo(d: HarnessDescriptor): HarnessInfo {
  return {
    id: d.id,
    label: d.label,
    vendor: d.vendor,
    kind: d.kind,
    textCapable: (d.kind === 'api' || d.kind === 'local' || d.kind === 'cli') && d.capabilities.has('text'),
    modelSelectable: d.modelSelectable,
    effortLevels: d.effort.kind === 'levels' ? ([...d.effort.levels] as EffortLevel[]) : null,
    dataLeavesMachine: d.dataLeavesMachine,
    latency: d.latency
  }
}

export function listHarnessInfos(): HarnessInfo[] {
  return listHarnessDescriptors().map(toHarnessInfo)
}
