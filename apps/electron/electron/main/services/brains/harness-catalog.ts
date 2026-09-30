/**
 * Every harness the pipeline can name, in one list: the brains of the registry, the audio engines
 * and Jev. The Pipeline page reads it to fill its harness list and to grey out what a step cannot use.
 */
import { BrainRegistry, getBrainRegistry } from './brain-registry'
import { describeBrain, missingCapabilities, type HarnessCapability, type HarnessDescriptor } from './descriptor'
import { ENGINE_DESCRIPTORS, JEV_DESCRIPTOR } from './engine-descriptors'

export function listHarnessDescriptors(registry: BrainRegistry = getBrainRegistry()): HarnessDescriptor[] {
  return [...registry.list().map(describeBrain), ...ENGINE_DESCRIPTORS, JEV_DESCRIPTOR]
}

export function findHarness(id: string, registry: BrainRegistry = getBrainRegistry()): HarnessDescriptor | null {
  return listHarnessDescriptors(registry).find((d) => d.id === id) ?? null
}

/** The harnesses that have every capability in `required`. */
export function harnessesWith(
  required: readonly HarnessCapability[],
  registry: BrainRegistry = getBrainRegistry()
): HarnessDescriptor[] {
  return listHarnessDescriptors(registry).filter((d) => missingCapabilities(d, required).length === 0)
}
