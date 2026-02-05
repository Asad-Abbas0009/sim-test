import { useState, useEffect } from 'react'
import { 
  savePlanning,
  tableIn, 
  tableOut, 
  stopCt,
  applyReconstruction,
} from '../api/backend'
import { useFrontendDicomContext } from '../contexts/FrontendDicomContext'
import HierarchicalCaseSelector from './HierarchicalCaseSelector'

interface ScanState {
  isScanning: boolean
  currentSlice: number
  totalSlices: number
}

interface PlanningData {
  z_pixel_start?: number
  z_pixel_end?: number
  scout_height_px?: number
  fov?: { x_min: number; x_max: number; y_min: number; y_max: number }
}

interface LeftControlPanelProps {
  caseId: string
  onCaseChange?: (caseId: string) => void
  onScoutScan?: () => void
  onScanStateChange?: (state: Partial<ScanState>) => void
  scanState?: ScanState
  isPlanningActive?: boolean
  onPlanningStart?: () => void
  onPlanningEnd?: () => void
  planningData?: PlanningData
  reconParams?: {
    sliceThickness?: number
    sliceSpacing?: number
  }
  onReconParamsChange?: (params: { sliceThickness?: number; sliceSpacing?: number }) => void
  onReconstructionApplied?: () => void
  scoutCompleted?: boolean  // Track if scout scan has been completed
  /** When true, panel is visually dimmed and all controls are disabled (no clicks) */
  isDisabled?: boolean
}

const LeftControlPanel = ({ 
  caseId,
  onCaseChange,
  onScoutScan, 
  onScanStateChange, 
  scanState, 
  isPlanningActive, 
  onPlanningStart, 
  onPlanningEnd, 
  planningData,
  reconParams,
  onReconParamsChange,
  onReconstructionApplied,
  scoutCompleted = false,
  isDisabled = false
}: LeftControlPanelProps) => {
  const { mode, files, clearFiles } = useFrontendDicomContext()
  const [position, setPosition] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  // Patient info state
  const [patientName, setPatientName] = useState('')
  const [patientAge, setPatientAge] = useState('')
  const [userId, setUserId] = useState('')
  const [patientId, setPatientId] = useState('')
  
  // Local recon state
  const [localReconThickness, setLocalReconThickness] = useState(reconParams?.sliceThickness ?? 5.0)
  const [localReconSpacing, setLocalReconSpacing] = useState(reconParams?.sliceSpacing ?? 5.0)
  
  // Workflow state - track if planning has been completed
  const [planningCompleted, setPlanningCompleted] = useState(false)

  // Reset workflow when case changes
  useEffect(() => {
    setPlanningCompleted(false)
  }, [caseId])
  
  // Update local state when reconParams prop changes
  useEffect(() => {
    if (reconParams) {
      setLocalReconThickness(reconParams.sliceThickness ?? 5.0)
      setLocalReconSpacing(reconParams.sliceSpacing ?? 5.0)
    }
  }, [reconParams])
  
  // Workflow conditions
  const canStartPlanning = scoutCompleted && !isPlanningActive && !planningCompleted
  const canEndPlanning = isPlanningActive
  const canEditRecon = planningCompleted && !scanState?.isScanning
  const canStartScan = planningCompleted && !scanState?.isScanning

  const handleScoutScan = () => {
    if (onScoutScan) {
      onScoutScan()
    }
  }

  const handleStartScan = async () => {
    console.log('Start Scan - applying reconstruction and starting scan')
    setLoading(true)
    setError(null)
    
    try {
      // 1. Get planning data (if available)
      const planning = planningData || {}
      
      // 2. Get recon parameters (use local state or default to 5.0mm)
      const sliceThickness = localReconThickness ?? reconParams?.sliceThickness ?? 5.0
      const sliceSpacing = localReconSpacing ?? reconParams?.sliceSpacing ?? 5.0
      
      // 3. Apply reconstruction
      if (caseId) {
        console.log(`[Start Scan] Applying reconstruction: thickness=${sliceThickness}mm, spacing=${sliceSpacing}mm`)
        const reconResult = await applyReconstruction({
          case_id: caseId,
          slice_thickness_mm: sliceThickness,
          slice_spacing_mm: sliceSpacing,
          planning: planning
        })
        console.log('[Start Scan] Reconstruction applied:', reconResult)
        
        // Trigger viewer refresh to load reconstructed DICOM
        if (onReconstructionApplied) {
          onReconstructionApplied()
        }
      } else {
        console.warn('[Start Scan] No caseId provided, skipping reconstruction')
      }
      
      // 4. Set scanning state to trigger cine playback
      if (onScanStateChange) {
        onScanStateChange({
          isScanning: true,
          currentSlice: 0,
          totalSlices: 0
        })
      }
    } catch (e: any) {
      console.error('[Start Scan] Error:', e)
      setError(e?.message || 'Failed to start scan')
    } finally {
      setLoading(false)
    }
  }

  const handleStopScan = async () => {
    setLoading(true)
    setError(null)
    try {
      if (onScanStateChange) {
        onScanStateChange({ isScanning: false })
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to stop scan')
    } finally {
      setLoading(false)
    }
  }

  const handleTableIn = async () => {
    try {
      const result = await tableIn()
      setPosition(result.table_position_mm?.toFixed(1) || '')
    } catch (e: any) {
      setError(e?.message || 'Failed to move table IN')
    }
  }

  const handleTableOut = async () => {
    try {
      const result = await tableOut()
      setPosition(result.table_position_mm?.toFixed(1) || '')
    } catch (e: any) {
      setError(e?.message || 'Failed to move table OUT')
    }
  }

  const handleStopCt = async () => {
    try {
      await stopCt()
      if (onScanStateChange) {
        onScanStateChange({ isScanning: false })
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to stop CT')
    }
  }

  const handleStartPlanning = () => {
    if (onPlanningStart) {
      onPlanningStart()
    } else {
      console.warn('onPlanningStart handler not provided')
    }
  }

  const handleEndPlanning = async () => {
    // Save planning to backend when End Planning is clicked
    if (planningData && planningData.z_pixel_start !== undefined && planningData.z_pixel_end !== undefined) {
      try {
        setLoading(true)
        
        const fov = planningData.fov || { x_min: 100, x_max: 300, y_min: 100, y_max: 300 }
        await savePlanning({
          case_id: caseId,
          z_pixel_start: Math.round(planningData.z_pixel_start),
          z_pixel_end: Math.round(planningData.z_pixel_end),
          scout_height_px: Math.round(planningData.scout_height_px || 1000),
          fov: {
            x_min: Math.round(fov.x_min),
            x_max: Math.round(fov.x_max),
            y_min: Math.round(fov.y_min),
            y_max: Math.round(fov.y_max)
          }
        })
        
        console.log('Planning saved:', planningData)
        
        // Mark planning as completed to enable reconstruction and start scan
        setPlanningCompleted(true)
      } catch (e) {
        console.error('Failed to save planning:', e)
        setError('Failed to save planning')
      } finally {
        setLoading(false)
      }
    }
    
    // Call parent handler to deactivate planning
    if (onPlanningEnd) {
      onPlanningEnd()
    } else {
      console.warn('onPlanningEnd handler not provided')
    }
  }

  return (
    <div
      className={`w-[260px] min-w-[260px] shrink-0 bg-gradient-to-r from-slate-900 to-slate-950 border-r border-slate-800 p-5 flex flex-col gap-5 overflow-y-auto shadow-inner shadow-black/30 relative ${
        isDisabled ? 'opacity-50 pointer-events-none' : ''
      }`}
    >
      {/* Patient Info Section */}
      <div className="flex flex-col gap-3 bg-gradient-to-r from-cyan-900/20 to-slate-900/50 border border-cyan-800/50 rounded-md p-3 shadow-inner shadow-black/30">
        <div className="pb-2 border-b border-cyan-800/50">
          <h3 className="text-xs font-semibold text-cyan-200 uppercase tracking-wide flex items-center gap-2">
            <span>👤</span> Patient Info
          </h3>
        </div>
        
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-xs text-slate-400">Patient Name</label>
            <input
              type="text"
              className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100 text-sm shadow-inner shadow-black/30 focus:outline-none focus:ring focus:ring-cyan-500/30"
              placeholder="Enter name"
              value={patientName}
              onChange={(e) => setPatientName(e.target.value)}
            />
          </div>
          
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400">Age</label>
            <input
              type="text"
              className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100 text-sm shadow-inner shadow-black/30 focus:outline-none focus:ring focus:ring-cyan-500/30"
              placeholder="Age"
              value={patientAge}
              onChange={(e) => setPatientAge(e.target.value)}
            />
          </div>
          
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400">User ID</label>
            <input
              type="text"
              className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100 text-sm shadow-inner shadow-black/30 focus:outline-none focus:ring focus:ring-cyan-500/30"
              placeholder="User ID"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            />
          </div>
          
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-xs text-slate-400">Patient ID</label>
            <input
              type="text"
              className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100 text-sm shadow-inner shadow-black/30 focus:outline-none focus:ring focus:ring-cyan-500/30"
              placeholder="Enter patient ID"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Mode Indicator (Option 2 default: backend streaming) */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-400">Mode:</span>
          <span className={`px-2 py-1 rounded ${
            mode === 'frontend'
              ? 'bg-green-600/20 text-green-300 border border-green-600/50'
              : 'bg-slate-700/50 text-slate-300 border border-slate-600/50'
          }`}>
            {mode === 'frontend' ? 'Frontend (local)' : 'Backend (streaming)'}
          </span>
          {mode === 'frontend' && files.length > 0 && (
            <span className="text-slate-500">({files.length} files)</span>
          )}
        </div>
        {mode === 'frontend' && (
          <button
            onClick={clearFiles}
            className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 transition"
          >
            Clear Files
          </button>
        )}
      </div>

      {/* Dataset Selector */}
      {onCaseChange && (
        <div className="mb-2">
          <HierarchicalCaseSelector currentCaseId={caseId} onCaseChange={onCaseChange} />
        </div>
      )}

      {/* Scanner Controls */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="text-2xl">🖥️</div>
          <input
            type="text"
            className="flex-1 rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-slate-100 text-sm shadow-inner shadow-black/30 focus:outline-none focus:ring focus:ring-blue-500/30"
            placeholder="Pos"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
          />
        </div>
        <div className="flex justify-center gap-2">
          <button 
            onClick={handleTableIn}
            disabled={loading || scanState?.isScanning}
            className="w-16 h-16 rounded-full bg-gradient-to-br from-green-500 to-green-600 text-white font-bold shadow-lg shadow-green-900/50 border border-green-700 hover:scale-[1.02] transition disabled:opacity-50 disabled:cursor-not-allowed"
            title="Move table IN"
          >
            IN
          </button>
          <button 
            onClick={handleTableOut}
            disabled={loading || scanState?.isScanning}
            className="w-16 h-16 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 text-white font-bold shadow-lg shadow-amber-900/50 border border-amber-600 hover:scale-[1.02] transition disabled:opacity-50 disabled:cursor-not-allowed"
            title="Move table OUT"
          >
            OUT
          </button>
          <button 
            onClick={handleStopCt}
            disabled={loading}
            className="w-16 h-16 rounded-full bg-gradient-to-br from-rose-500 to-red-600 text-white font-bold shadow-lg shadow-rose-900/50 border border-red-700 hover:scale-[1.02] transition disabled:opacity-50 disabled:cursor-not-allowed"
            title="Emergency STOP"
          >
            STOP
          </button>
        </div>
        {error && (
          <div className="text-xs text-rose-200 bg-rose-500/10 border border-rose-500/50 rounded px-2 py-1">
            {error}
          </div>
        )}
      </div>

      {/* Workflow Section - Following the sequence: Scout -> Planning -> Recon -> Scan */}
      <div className="flex flex-col gap-3 bg-gradient-to-r from-slate-800/30 to-slate-900/30 border border-slate-700 rounded-md p-3 shadow-inner shadow-black/30">
        {/* Row 1: Scout Scan | Start Planning */}
        <div className="grid grid-cols-2 gap-2">
          <button
            className="px-3 py-3 rounded-md border border-slate-700 bg-slate-800/80 text-slate-100 text-sm font-medium hover:bg-slate-700 transition shadow-inner shadow-black/30 disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleScoutScan}
            disabled={loading || scanState?.isScanning}
          >
            Scout Scan
          </button>
          <button
            className={`px-3 py-3 rounded-md border text-sm font-medium transition shadow-inner shadow-black/30 disabled:opacity-40 disabled:cursor-not-allowed ${
              canStartPlanning
                ? 'border-blue-600 bg-blue-600/80 text-white hover:bg-blue-500'
                : 'border-slate-700 bg-slate-800/80 text-slate-400'
            }`}
            onClick={handleStartPlanning}
            disabled={!canStartPlanning || loading}
          >
            Start Planning
          </button>
        </div>

        {/* Row 2: End Planning (centered) */}
        <div className="flex justify-center">
          <button
            className={`px-6 py-3 rounded-md border text-sm font-medium transition shadow-inner shadow-black/30 disabled:opacity-40 disabled:cursor-not-allowed ${
              canEndPlanning
                ? 'border-emerald-600 bg-emerald-600/80 text-white hover:bg-emerald-500'
                : 'border-slate-700 bg-slate-800/80 text-slate-400'
            }`}
            onClick={handleEndPlanning}
            disabled={!canEndPlanning || loading}
          >
            End Planning
          </button>
        </div>

        {/* Reconstruction Section */}
        <div className={`flex flex-col gap-2 p-3 rounded-md border transition ${
          canEditRecon 
            ? 'border-slate-600 bg-slate-800/50' 
            : 'border-slate-800 bg-slate-900/30 opacity-50'
        }`}>
          <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Reconstruction</h4>
          
          <div className="flex flex-col gap-2">
            <label className="text-xs text-slate-400 font-medium">
              Slice Thickness (mm)
            </label>
            <input
              type="number"
              aria-label="Slice Thickness in millimeters"
              className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 text-sm shadow-inner shadow-black/30 focus:outline-none focus:ring focus:ring-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder="e.g. 5"
              value={localReconThickness}
              onChange={(e) => {
                const value = parseFloat(e.target.value) || 0
                setLocalReconThickness(value)
                if (onReconParamsChange) {
                  onReconParamsChange({
                    sliceThickness: value,
                    sliceSpacing: localReconSpacing
                  })
                }
              }}
              step="0.1"
              min="0.5"
              max="10"
              disabled={!canEditRecon || loading}
            />
            <label className="text-xs text-slate-400 font-medium">
              Slice Spacing (mm)
            </label>
            <input
              type="number"
              aria-label="Slice Spacing in millimeters"
              className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 text-sm shadow-inner shadow-black/30 focus:outline-none focus:ring focus:ring-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder="e.g. 5"
              value={localReconSpacing}
              onChange={(e) => {
                const value = parseFloat(e.target.value) || 0
                setLocalReconSpacing(value)
                if (onReconParamsChange) {
                  onReconParamsChange({
                    sliceThickness: localReconThickness,
                    sliceSpacing: value
                  })
                }
              }}
              step="0.1"
              min="0.1"
              disabled={!canEditRecon || loading}
            />
          </div>
        </div>

        {/* Row 4: Start Scan (full width) */}
        <button
          className={`px-3 py-3 rounded-md border text-sm font-medium transition shadow-inner shadow-black/30 disabled:opacity-40 disabled:cursor-not-allowed ${
            scanState?.isScanning
              ? 'border-red-600 bg-red-600/80 text-white hover:bg-red-500'
              : canStartScan
                ? 'border-emerald-600 bg-emerald-600/80 text-white hover:bg-emerald-500'
                : 'border-slate-700 bg-slate-800/80 text-slate-400'
          }`}
          onClick={scanState?.isScanning ? handleStopScan : handleStartScan}
          disabled={(!canStartScan && !scanState?.isScanning) || loading}
        >
          {scanState?.isScanning ? 'Stop Scan' : 'Start Scan'}
        </button>
      </div>
      
      {/* Workflow Status Indicator */}
      <div className="flex flex-col gap-1 text-xs">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${scoutCompleted ? 'bg-emerald-500' : 'bg-slate-600'}`}></span>
          <span className={scoutCompleted ? 'text-emerald-400' : 'text-slate-500'}>Scout</span>
          <span className={`w-2 h-2 rounded-full ${planningCompleted ? 'bg-emerald-500' : isPlanningActive ? 'bg-blue-500 animate-pulse' : 'bg-slate-600'}`}></span>
          <span className={planningCompleted ? 'text-emerald-400' : isPlanningActive ? 'text-blue-400' : 'text-slate-500'}>Planning</span>
          <span className={`w-2 h-2 rounded-full ${scanState?.isScanning ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`}></span>
          <span className={scanState?.isScanning ? 'text-emerald-400' : 'text-slate-500'}>Scan</span>
        </div>
      </div>
      
      {scanState?.isScanning && (
        <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/50 rounded px-2 py-1 text-center">
          Scanning: {scanState.currentSlice || 0} / {scanState.totalSlices || 0}
        </div>
      )}
    </div>
  )
}

export default LeftControlPanel
