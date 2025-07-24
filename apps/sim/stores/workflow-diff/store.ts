import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { createLogger } from '@/lib/logs/console-logger'
import { WorkflowDiffEngine, type DiffAnalysis } from '@/lib/workflows/diff'
import { useWorkflowStore } from '../workflows/workflow/store'
import { useSubBlockStore } from '../workflows/subblock/store'
import { useWorkflowRegistry } from '../workflows/registry/store'
import type { WorkflowState } from '../workflows/workflow/types'

const logger = createLogger('WorkflowDiffStore')

// Create a singleton diff engine instance
const diffEngine = new WorkflowDiffEngine()

interface WorkflowDiffState {
  isShowingDiff: boolean
  diffWorkflow: WorkflowState | null
  diffAnalysis: DiffAnalysis | null
  diffMetadata: {
    source: string
    timestamp: number
  } | null
}

interface WorkflowDiffActions {
  setProposedChanges: (yamlContent: string, diffAnalysis?: DiffAnalysis) => Promise<void>
  clearDiff: () => void
  getCurrentWorkflowForCanvas: () => WorkflowState
  toggleDiffView: () => void
  acceptChanges: () => Promise<void>
  rejectChanges: () => void
}

/**
 * Simplified diff store that delegates to the diff engine
 * This maintains backward compatibility while removing redundant logic
 */
export const useWorkflowDiffStore = create<WorkflowDiffState & WorkflowDiffActions>()(
  devtools(
    (set, get) => ({
      isShowingDiff: false,
      diffWorkflow: null,
      diffAnalysis: null,
      diffMetadata: null,

      setProposedChanges: async (yamlContent: string, diffAnalysis?: DiffAnalysis) => {
        logger.info('Setting proposed changes via YAML')
        
        const result = await diffEngine.createDiffFromYaml(yamlContent, diffAnalysis)
        
        if (result.success && result.diff) {
          set({ 
            isShowingDiff: true,
            diffWorkflow: result.diff.proposedState,
            diffAnalysis: result.diff.diffAnalysis || null,
            diffMetadata: result.diff.metadata
          })
          logger.info('Diff created successfully')
        } else {
          logger.error('Failed to create diff:', result.errors)
          throw new Error(result.errors?.join(', ') || 'Failed to create diff')
        }
      },

      clearDiff: () => {
        logger.info('Clearing diff')
        diffEngine.clearDiff()
        set({ 
          isShowingDiff: false,
          diffWorkflow: null,
          diffAnalysis: null,
          diffMetadata: null
        })
      },

      toggleDiffView: () => {
        const { isShowingDiff } = get()
        logger.info('Toggling diff view', { currentState: isShowingDiff })
        set({ isShowingDiff: !isShowingDiff })
      },

      acceptChanges: async () => {
        const activeWorkflowId = useWorkflowRegistry.getState().activeWorkflowId
        
        if (!activeWorkflowId) {
          logger.error('No active workflow ID found when accepting diff')
          throw new Error('No active workflow found')
        }

        logger.info('Accepting proposed changes')
        
        try {
          const cleanState = diffEngine.acceptDiff()
          if (!cleanState) {
            logger.warn('No diff to accept')
            return
          }

          // Update the main workflow store state
          useWorkflowStore.setState({
            blocks: cleanState.blocks,
            edges: cleanState.edges,
            loops: cleanState.loops,
            parallels: cleanState.parallels,
          })
          
          // Update the subblock store with the values from the diff workflow blocks
          const subblockValues: Record<string, Record<string, any>> = {}
          
          Object.entries(cleanState.blocks).forEach(([blockId, block]) => {
            subblockValues[blockId] = {}
            Object.entries(block.subBlocks || {}).forEach(([subblockId, subblock]) => {
              subblockValues[blockId][subblockId] = (subblock as any).value
            })
          })
          
          useSubBlockStore.setState((state) => ({
            workflowValues: {
              ...state.workflowValues,
              [activeWorkflowId]: subblockValues,
            },
          }))
          
          // Trigger save and history
          const workflowStore = useWorkflowStore.getState()
          workflowStore.updateLastSaved()
          
          logger.info('Successfully applied diff workflow to main store')
          
          // Persist to database
          try {
            logger.info('Persisting accepted diff changes to database')
            
            const response = await fetch(`/api/workflows/${activeWorkflowId}/state`, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                ...cleanState,
                lastSaved: Date.now(),
              }),
            })

            if (!response.ok) {
              const errorData = await response.json()
              logger.error('Failed to persist accepted diff to database:', errorData)
              throw new Error(errorData.error || `Failed to save: ${response.statusText}`)
            }

            const result = await response.json()
            logger.info('Successfully persisted accepted diff to database', {
              blocksCount: result.blocksCount,
              edgesCount: result.edgesCount,
            })
            
          } catch (persistError) {
            logger.error('Failed to persist accepted diff to database:', persistError)
            // Don't throw here - the store is already updated, so the UI is correct
            logger.warn('Diff was applied to local stores but not persisted to database')
          }
          
          // Clear the diff
          get().clearDiff()
          
        } catch (error) {
          logger.error('Failed to accept changes:', error)
          throw error
        }
      },

      rejectChanges: () => {
        logger.info('Rejecting proposed changes')
        get().clearDiff()
      },

      getCurrentWorkflowForCanvas: () => {
        const { isShowingDiff } = get()
        
        if (isShowingDiff && diffEngine.hasDiff()) {
          logger.debug('Returning diff workflow for canvas')
          const currentState = useWorkflowStore.getState().getWorkflowState()
          return diffEngine.getDisplayState(currentState)
        }
        
        // Return the actual workflow state using the main store's method
        return useWorkflowStore.getState().getWorkflowState()
      },
    }),
    { name: 'workflow-diff-store' }
  )
) 