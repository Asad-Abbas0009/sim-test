import { useState, useEffect, useCallback } from 'react'
import { DataProvider, useDataContext } from '../contexts/DataContext'
import { FilmingProvider } from '../contexts/FilmingContext'
import { FrontendDicomProvider } from '../contexts/FrontendDicomContext'
import LeftControlPanel from './LeftControlPanel'
import ImageDisplayArea from './ImageDisplayArea'
import VerticalTabs from './VerticalTabs'
import TopBar from './TopBar'
import FooterBar from './FooterBar'

interface ScanState {
  isScanning: boolean
  currentSlice: number
  totalSlices: number
}

// Inner component that can use DataContext
const SimTomLayoutInner = () => {
  const { clearCache } = useDataContext()
  // Case ID - hierarchical path like 'Abdomen/CT Abdomen Contrast/case_001'
  const [caseId, setCaseId] = useState('')
  
  const [activeTab, setActiveTab] = useState<'EXAMINATION' | 'VIEWING' | 'FILMING'>('EXAMINATION')
  const [currentTime, setCurrentTime] = useState(new Date())
  const [scoutRefreshToken, setScoutRefreshToken] = useState(0)
  const [reconRefreshToken, setReconRefreshToken] = useState(0)
  const [isPlanningActive, setIsPlanningActive] = useState(false)
  const [scanState, setScanState] = useState<ScanState>({
    isScanning: false,
    currentSlice: 0,
    totalSlices: 0,
  })
  const [planningData, setPlanningData] = useState<{
    z_pixel_start?: number
    z_pixel_end?: number
    scout_height_px?: number
    fov?: { x_min: number; x_max: number; y_min: number; y_max: number }
  }>({})
  const [reconParams, setReconParams] = useState<{
    sliceThickness?: number
    sliceSpacing?: number
  }>({
    sliceThickness: 5.0,
    sliceSpacing: 5.0
  })
  // Track if scout scan has been completed (enables Start Planning)
  const [scoutCompleted, setScoutCompleted] = useState(false)

  // Update time every second
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date())
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const handleScoutScan = () => {
    // Trigger refresh of scout image
    setScoutRefreshToken(Date.now())
    // Mark scout as completed to enable Start Planning
    setScoutCompleted(true)
  }

  const handleScanStateChange = useCallback((newState: Partial<ScanState>) => {
    setScanState((prev) => ({ ...prev, ...newState }))
  }, [])

  const handlePlanningStart = () => {
    setIsPlanningActive(true)
  }

  const handlePlanningEnd = async () => {
    // Deactivate planning mode
    setIsPlanningActive(false)
    // Refresh scout to update summary table with new planning
    setScoutRefreshToken(Date.now())
  }

  const handleCaseChange = useCallback((newCaseId: string) => {
    console.log('Case changed from', caseId, 'to', newCaseId)
    // Clear cache for old case (optional - cache persists across cases)
    // clearCache(caseId)
    setCaseId(newCaseId)
    // Reset all state when case changes (but don't auto-load scout)
    setScanState({
      isScanning: false,
      currentSlice: 0,
      totalSlices: 0,
    })
    setPlanningData({})
    setIsPlanningActive(false)
    setScoutCompleted(false)  // Reset workflow when case changes
    setScoutRefreshToken(0)   // Don't auto-load scout for new case
  }, [caseId, clearCache])

  return (
    <div className="flex h-screen w-full flex-col bg-slate-950 text-slate-100 overflow-hidden">
      <TopBar currentTime={currentTime} />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <LeftControlPanel 
          caseId={caseId}
          onCaseChange={handleCaseChange}
          onScoutScan={handleScoutScan}
          onScanStateChange={handleScanStateChange}
          scanState={scanState}
          isPlanningActive={isPlanningActive}
          onPlanningStart={handlePlanningStart}
          onPlanningEnd={handlePlanningEnd}
          planningData={planningData}
          reconParams={reconParams}
          onReconParamsChange={setReconParams}
          onReconstructionApplied={() => setReconRefreshToken(Date.now())}
          scoutCompleted={scoutCompleted}
          isDisabled={activeTab !== 'EXAMINATION'}
        />

        <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-slate-900/70 backdrop-blur-sm">
          <ImageDisplayArea 
            caseId={caseId}
            activeTab={activeTab} 
            scoutRefreshToken={scoutRefreshToken}
            scanState={scanState}
            isPlanningActive={isPlanningActive}
            onPlanningDataReady={setPlanningData}
            reconRefreshToken={reconRefreshToken}
            onScanComplete={() => {
              // Stop scanning when playback completes
              setScanState(prev => ({ ...prev, isScanning: false }))
              console.log('[SimTomLayout] Scan playback complete!')
            }}
          />
        </div>

        <VerticalTabs activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      <FooterBar currentTime={currentTime} />
    </div>
  )
}

const SimTomLayout = () => {
  return (
    <FrontendDicomProvider>
      <DataProvider>
        <FilmingProvider>
          <SimTomLayoutInner />
        </FilmingProvider>
      </DataProvider>
    </FrontendDicomProvider>
  )
}

export default SimTomLayout
