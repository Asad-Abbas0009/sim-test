import { useState, useEffect, useRef } from 'react'
import { savePlanning, base64ToDataUrl } from '../api/backend'
import { useDataContext } from '../contexts/DataContext'
import { useFrontendDicomContext } from '../contexts/FrontendDicomContext'
import { generateScout, imageDataToDataUrl } from '../utils/frontendScoutGenerator'

/**
 * Scout Viewer Component
 * Displays scout image and allows planning via mouse
 */
interface ScoutViewerProps {
  caseId: string
  refreshToken?: number
  isPlanningActive?: boolean
  onPlanningDataReady?: (data: {
    z_pixel_start: number
    z_pixel_end: number
    scout_height_px: number
    fov: { x_min: number; x_max: number; y_min: number; y_max: number }
  }) => void
}

interface PlanningLines {
  startY: number  // Z start pixel (top line)
  endY: number    // Z end pixel (bottom line)
  fov: {
    x_min: number
    x_max: number
    y_min: number
    y_max: number
  }
}

const ScoutViewer: React.FC<ScoutViewerProps> = ({
  caseId,
  refreshToken,
  isPlanningActive = false,
  onPlanningDataReady,
}) => {
  const { getScoutImage } = useDataContext()
  const { mode, volume, metadata } = useFrontendDicomContext()
  const containerRef = useRef<HTMLDivElement>(null)
  const [scoutUrl, setScoutUrl] = useState<string | null>(null)
  const [scoutSize, setScoutSize] = useState<{ width: number; height: number } | null>(null)
  const [zRange, setZRange] = useState<{ min: number; max: number }>({ min: 0, max: 0 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  // Planning state (pixel coordinates)
  const [planning, setPlanning] = useState<PlanningLines>({
    startY: 100,
    endY: 400,
    fov: { x_min: 100, x_max: 300, y_min: 100, y_max: 300 }
  })
  
  // Dragging state
  const [dragging, setDragging] = useState<'start' | 'end' | 'fov' | 'fov-top' | 'fov-bottom' | 'fov-left' | 'fov-right' | null>(null)
  const dragStartRef = useRef<{ y: number; startY: number; endY: number; fov: typeof planning.fov }>({
    y: 0, startY: 0, endY: 0, fov: planning.fov
  })

  // Load scout image (uses cached data from context or frontend volume)
  const loadScout = async () => {
    setLoading(true)
    setError(null)

    try {
      // Check mode: frontend or backend
      if (mode === 'frontend' && volume && metadata) {
        // Generate scout from frontend volume
        console.log('[ScoutViewer] Generating scout from frontend volume')
        const scoutImageData = generateScout(volume, 'frontal', 40, 300, 0.9)
        const imgUrl = imageDataToDataUrl(scoutImageData)
        setScoutUrl(imgUrl)
        setScoutSize({ width: scoutImageData.width, height: scoutImageData.height })
        
        // Calculate Z range from volume
        const zMin = Math.min(...volume.zPositions)
        const zMax = Math.max(...volume.zPositions)
        setZRange({ min: zMin, max: zMax })
        
        // Initialize planning lines at 20% and 80% of image height
        const defaultStartY = Math.round(scoutImageData.height * 0.2)
        const defaultEndY = Math.round(scoutImageData.height * 0.8)
        const defaultFovMargin = Math.round(scoutImageData.width * 0.2)
        
        setPlanning({
          startY: defaultStartY,
          endY: defaultEndY,
          fov: {
            x_min: defaultFovMargin,
            x_max: scoutImageData.width - defaultFovMargin,
            y_min: defaultStartY,
            y_max: defaultEndY
          }
        })
      } else {
        // Use backend API (existing behavior)
        if (!caseId) {
          setLoading(false)
          return
        }
        
        const response = await getScoutImage(caseId, 'frontal')
        
        if (!response) {
          setError('Failed to load scout image')
          return
        }
        
        const imgUrl = base64ToDataUrl(response.scout_image)
        setScoutUrl(imgUrl)
        setScoutSize({ width: response.cols, height: response.rows })
        setZRange({ min: response.z_min, max: response.z_max })
        
        // Initialize planning lines at 20% and 80% of image height
        const defaultStartY = Math.round(response.rows * 0.2)
        const defaultEndY = Math.round(response.rows * 0.8)
        const defaultFovMargin = Math.round(response.cols * 0.2)
        
        setPlanning({
          startY: defaultStartY,
          endY: defaultEndY,
          fov: {
            x_min: defaultFovMargin,
            x_max: response.cols - defaultFovMargin,
            y_min: defaultStartY,
            y_max: defaultEndY
          }
        })
      }
    } catch (e: any) {
      console.error('Failed to load scout:', e)
      setError(e?.message || 'Failed to load scout image')
    } finally {
      setLoading(false)
    }
  }

  // Clear scout when case changes (don't show previous case's scout)
  useEffect(() => {
    if (!caseId) {
      setScoutUrl(null)
      setScoutSize(null)
      setError(null)
      setPlanning({
        startY: 100,
        endY: 400,
        fov: { x_min: 100, x_max: 300, y_min: 100, y_max: 300 }
      })
    }
  }, [caseId])

  // Reload scout only when Scout Scan is clicked (refreshToken), not on case change
  useEffect(() => {
    if (refreshToken && refreshToken > 0 && caseId) {
      loadScout()
    }
  }, [refreshToken, caseId, mode, volume])

  // Notify parent of planning data changes
  useEffect(() => {
    if (onPlanningDataReady && scoutSize) {
      onPlanningDataReady({
        z_pixel_start: planning.startY,
        z_pixel_end: planning.endY,
        scout_height_px: scoutSize.height,
        fov: planning.fov
      })
    }
  }, [planning, scoutSize, onPlanningDataReady])

  // Mouse handlers for planning
  const handleMouseDown = (e: React.MouseEvent, target: typeof dragging) => {
    if (!isPlanningActive) return
    
    setDragging(target)
    dragStartRef.current = {
      y: e.clientY,
      startY: planning.startY,
      endY: planning.endY,
      fov: { ...planning.fov }
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging || !containerRef.current || !scoutSize) return

    const rect = containerRef.current.getBoundingClientRect()
    const scaleY = scoutSize.height / rect.height
    const scaleX = scoutSize.width / rect.width
    const deltaY = (e.clientY - dragStartRef.current.y) * scaleY
    const deltaX = (e.clientX - rect.left) * scaleX
    const currentY = (e.clientY - rect.top) * scaleY

    if (dragging === 'start') {
      const newStartY = Math.max(0, Math.min(dragStartRef.current.startY + deltaY, planning.endY - 20))
      setPlanning(prev => ({
        ...prev,
        startY: newStartY,
        fov: { ...prev.fov, y_min: newStartY }
      }))
    } else if (dragging === 'end') {
      const newEndY = Math.min(scoutSize.height, Math.max(dragStartRef.current.endY + deltaY, planning.startY + 20))
      setPlanning(prev => ({
        ...prev,
        endY: newEndY,
        fov: { ...prev.fov, y_max: newEndY }
      }))
    } else if (dragging === 'fov') {
      // Move entire FOV box
      const fovWidth = dragStartRef.current.fov.x_max - dragStartRef.current.fov.x_min
      const fovHeight = dragStartRef.current.fov.y_max - dragStartRef.current.fov.y_min
      const newXMin = Math.max(0, Math.min(deltaX - fovWidth / 2, scoutSize.width - fovWidth))
      const newYMin = Math.max(0, Math.min(currentY - fovHeight / 2, scoutSize.height - fovHeight))
      
      setPlanning(prev => ({
        ...prev,
        fov: {
          x_min: newXMin,
          x_max: newXMin + fovWidth,
          y_min: newYMin,
          y_max: newYMin + fovHeight
        }
      }))
    } else if (dragging === 'fov-left') {
      const newXMin = Math.max(0, Math.min(deltaX, planning.fov.x_max - 20))
      setPlanning(prev => ({ ...prev, fov: { ...prev.fov, x_min: newXMin } }))
    } else if (dragging === 'fov-right') {
      const newXMax = Math.min(scoutSize.width, Math.max(deltaX, planning.fov.x_min + 20))
      setPlanning(prev => ({ ...prev, fov: { ...prev.fov, x_max: newXMax } }))
    } else if (dragging === 'fov-top') {
      const newYMin = Math.max(0, Math.min(currentY, planning.fov.y_max - 20))
      setPlanning(prev => ({ ...prev, startY: newYMin, fov: { ...prev.fov, y_min: newYMin } }))
    } else if (dragging === 'fov-bottom') {
      const newYMax = Math.min(scoutSize.height, Math.max(currentY, planning.fov.y_min + 20))
      setPlanning(prev => ({ ...prev, endY: newYMax, fov: { ...prev.fov, y_max: newYMax } }))
    }
  }

  const handleMouseUp = async () => {
    if (!dragging) return
    setDragging(null)
    
    // Auto-save planning when mouse released
    if (isPlanningActive && scoutSize) {
      try {
        await savePlanning({
          case_id: caseId,
          z_pixel_start: Math.round(planning.startY),
          z_pixel_end: Math.round(planning.endY),
          scout_height_px: Math.round(scoutSize.height),
          fov: {
            x_min: Math.round(planning.fov.x_min),
            x_max: Math.round(planning.fov.x_max),
            y_min: Math.round(planning.fov.y_min),
            y_max: Math.round(planning.fov.y_max)
          }
        })
        console.log('Planning saved automatically')
      } catch (e) {
        console.error('Failed to save planning:', e)
      }
    }
  }

  // Calculate display positions based on container size
  const getDisplayPosition = (pixelY: number): number => {
    if (!containerRef.current || !scoutSize) return 0
    const rect = containerRef.current.getBoundingClientRect()
    return (pixelY / scoutSize.height) * rect.height
  }

  const getDisplayX = (pixelX: number): number => {
    if (!containerRef.current || !scoutSize) return 0
    const rect = containerRef.current.getBoundingClientRect()
    return (pixelX / scoutSize.width) * rect.width
  }

  return (
    <div 
      ref={containerRef}
      className="relative h-full w-full bg-black overflow-hidden select-none"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Scout Image */}
      {scoutUrl && (
        <img
          src={scoutUrl}
          alt="Scout"
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          style={{ transform: 'scaleY(-1)' }}
          draggable={false}
        />
      )}

      {/* Planning Overlay - Only when planning is active and scout is loaded */}
      {scoutUrl && isPlanningActive && scoutSize && (
        <>
          {/* Start Line (Yellow - Top) */}
          <div
            className="absolute left-0 right-0 h-1 bg-yellow-400 cursor-ns-resize z-10"
            style={{ top: `${(planning.startY / scoutSize.height) * 100}%` }}
            onMouseDown={(e) => handleMouseDown(e, 'start')}
          >
            <div className="absolute left-2 -top-5 text-yellow-400 text-xs font-mono bg-black/70 px-1 rounded">
              START
            </div>
          </div>

          {/* End Line (Yellow - Bottom) */}
          <div
            className="absolute left-0 right-0 h-1 bg-yellow-400 cursor-ns-resize z-10"
            style={{ top: `${(planning.endY / scoutSize.height) * 100}%` }}
            onMouseDown={(e) => handleMouseDown(e, 'end')}
          >
            <div className="absolute left-2 top-1 text-yellow-400 text-xs font-mono bg-black/70 px-1 rounded">
              END
            </div>
          </div>

          {/* FOV Box */}
          <div
            className="absolute border-2 border-cyan-400 bg-cyan-400/10 cursor-move z-5"
            style={{
              left: `${(planning.fov.x_min / scoutSize.width) * 100}%`,
              top: `${(planning.fov.y_min / scoutSize.height) * 100}%`,
              width: `${((planning.fov.x_max - planning.fov.x_min) / scoutSize.width) * 100}%`,
              height: `${((planning.fov.y_max - planning.fov.y_min) / scoutSize.height) * 100}%`,
            }}
            onMouseDown={(e) => handleMouseDown(e, 'fov')}
          >
            {/* FOV Label */}
            <div className="absolute -top-5 left-1/2 -translate-x-1/2 text-cyan-400 text-xs font-mono bg-black/70 px-1 rounded">
              FOV
            </div>
            
            {/* Resize handles */}
            <div 
              className="absolute -left-1 top-1/2 -translate-y-1/2 w-2 h-8 bg-cyan-400 cursor-ew-resize"
              onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, 'fov-left') }}
            />
            <div 
              className="absolute -right-1 top-1/2 -translate-y-1/2 w-2 h-8 bg-cyan-400 cursor-ew-resize"
              onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, 'fov-right') }}
            />
            <div 
              className="absolute left-1/2 -translate-x-1/2 -top-1 w-8 h-2 bg-cyan-400 cursor-ns-resize"
              onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, 'fov-top') }}
            />
            <div 
              className="absolute left-1/2 -translate-x-1/2 -bottom-1 w-8 h-2 bg-cyan-400 cursor-ns-resize"
              onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, 'fov-bottom') }}
            />
          </div>
        </>
      )}

      {/* Z Range Info */}
      {scoutUrl && zRange.max !== 0 && (
        <div className="absolute bottom-2 left-2 text-white text-xs font-mono bg-black/70 px-2 py-1 rounded">
          Z: {zRange.min.toFixed(1)} → {zRange.max.toFixed(1)} mm
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-white bg-black/50">
          Loading scout…
        </div>
      )}

      {/* No Scout Message */}
      {!scoutUrl && !loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-400">
          Click "Scout Scan" to load
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-red-300 bg-black/60 px-4 text-center">
          {error}
        </div>
      )}

      {/* Planning Mode Indicator */}
      {isPlanningActive && (
        <div className="absolute top-2 right-2 bg-blue-600 text-white text-xs px-2 py-1 rounded">
          Planning Mode
        </div>
      )}
    </div>
  )
}

export default ScoutViewer
