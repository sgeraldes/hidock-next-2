import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SemanticMaintenancePanel } from '../SemanticMaintenancePanel'
const fixture=vi.hoisted(()=>({config:{brains:{taskRouting:{embed:'model-host-embed'},modelHostEmbedding:{spaceId:'space-fixture'}},transcription:{modelHostUrl:'https://fixture-host:8766',modelHostToken:'fixture-present'}},status:vi.fn(),start:vi.fn(),pause:vi.fn(),resume:vi.fn(),cancel:vi.fn()}))
vi.mock('@/store/domain/useConfigStore',()=>({useConfigStore:(select:any)=>select({config:fixture.config})}))
const idle={state:'idle',hostReady:null,completedRecordings:0,indexedChunks:0,batches:0,maxRecordings:1,maxBatches:4,activePartitionRows:0,otherPartitionRows:243110}
beforeEach(()=>{
 vi.clearAllMocks();fixture.config.brains.taskRouting.embed='model-host-embed'
 fixture.status.mockResolvedValue(idle);fixture.start.mockResolvedValue({...idle,state:'running',runId:'one',hostReady:true,provider:'model-host-embed',spaceId:'space-fixture',hostUrl:'https://fixture-host:8766'})
 fixture.pause.mockResolvedValue({...idle,state:'pausing',runId:'one'});fixture.resume.mockResolvedValue({...idle,state:'running',runId:'one'});fixture.cancel.mockResolvedValue({...idle,state:'cancelling',runId:'one'})
 window.electronAPI={semanticIndex:fixture} as any
})
it('reads status only on mount and truthfully shows empty index, preserved partitions and unchecked host',async()=>{
 render(<SemanticMaintenancePanel selected={fixture.config.brains.taskRouting.embed === 'model-host-embed'}/>);await screen.findByText('Not started')
 expect(screen.getByText('0 indexed chunks')).toBeVisible();expect(screen.getByText('243,110 chunks')).toBeVisible()
 expect(screen.getByText(/Not checked/)).toBeVisible();expect(fixture.start).not.toHaveBeenCalled();expect(fixture.resume).not.toHaveBeenCalled()
})
it('starts only an explicit one-recording four-batch request and displays returned state',async()=>{
 render(<SemanticMaintenancePanel selected={fixture.config.brains.taskRouting.embed === 'model-host-embed'}/>);await screen.findByText('Not started');fireEvent.click(screen.getByRole('button',{name:'Start one recording'}))
 await screen.findByText('Running');expect(fixture.start).toHaveBeenCalledExactlyOnceWith({maxRecordings:1,maxBatches:4})
 expect(screen.getByText('Ready at last check')).toBeVisible()
})
it('keeps pause transitional until backend says paused',async()=>{
 fixture.status.mockResolvedValue({...idle,state:'running',runId:'one'})
 render(<SemanticMaintenancePanel selected={fixture.config.brains.taskRouting.embed === 'model-host-embed'}/>);await screen.findByText('Running');fireEvent.click(screen.getByRole('button',{name:'Pause'}))
 await screen.findByText('Finishing current batch before pause');expect(fixture.pause).toHaveBeenCalledWith({runId:'one'})
 expect(screen.getByRole('button',{name:'Resume'})).toBeDisabled()
})
it('does not auto-resume interrupted work and resumes only its pinned run',async()=>{
 fixture.status.mockResolvedValue({...idle,state:'interrupted',runId:'saved',spaceId:'original-space'})
 render(<SemanticMaintenancePanel selected={fixture.config.brains.taskRouting.embed === 'model-host-embed'}/>);await screen.findByText(/Interrupted —/);expect(fixture.resume).not.toHaveBeenCalled()
 expect(screen.getByText('original-space')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'Resume'}))
 await waitFor(()=>expect(fixture.resume).toHaveBeenCalledWith({runId:'saved'}))
})
it('cancel waits for settlement instead of announcing cancellation complete',async()=>{
 fixture.status.mockResolvedValue({...idle,state:'running',runId:'one'})
 render(<SemanticMaintenancePanel selected={fixture.config.brains.taskRouting.embed === 'model-host-embed'}/>);await screen.findByText('Running');fireEvent.click(screen.getByRole('button',{name:'Cancel'}))
 await screen.findByText('Cancelling — waiting for the current request to settle');expect(fixture.cancel).toHaveBeenCalledWith({runId:'one'})
 expect(screen.getByRole('button',{name:'Start one recording'})).toBeDisabled()
})
it('disables actions when IPC status unavailable',async()=>{
 fixture.status.mockRejectedValue(new Error('offline'));render(<SemanticMaintenancePanel selected={fixture.config.brains.taskRouting.embed === 'model-host-embed'}/>);await screen.findByText('Index status unavailable')
 expect(screen.getByRole('button',{name:'Start one recording'})).toBeDisabled()
})
it('shows host refusal without claiming work started',async()=>{
 fixture.start.mockRejectedValue(new Error('Host unavailable; no fallback'))
 render(<SemanticMaintenancePanel selected={fixture.config.brains.taskRouting.embed === 'model-host-embed'}/>);await screen.findByText('Not started');fireEvent.click(screen.getByRole('button',{name:'Start one recording'}))
 expect(await screen.findByRole('alert')).toHaveTextContent('Host unavailable');expect(screen.queryByText('Running')).toBeNull()
})
it('requires selected bound remote provider before start',async()=>{
 fixture.config.brains.taskRouting.embed='gemini-api';render(<SemanticMaintenancePanel selected={fixture.config.brains.taskRouting.embed === 'model-host-embed'}/>);await screen.findByText('Not started')
 expect(screen.getByRole('button',{name:'Start one recording'})).toBeDisabled()
})

it('refuses resume of a saved operation larger than this UI limit',async()=>{
 fixture.status.mockResolvedValue({...idle,state:'paused',runId:'large',maxRecordings:20,maxBatches:100})
 render(<SemanticMaintenancePanel selected/>);await screen.findByText('Paused')
 expect(screen.getByRole('button',{name:'Resume'})).toBeDisabled()
 expect(screen.getByRole('alert')).toHaveTextContent('exceeds the one-recording/four-batch limit')
 expect(screen.getByRole('button',{name:'Cancel'})).toBeEnabled()
})
