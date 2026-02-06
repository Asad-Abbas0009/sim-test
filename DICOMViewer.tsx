import { useState, useEffect, useRef, useCallback } from 'react'
import { useFrontendDicomContext } from '../contexts/FrontendDicomContext'
import { useFilmingContext } from '../contexts/FilmingContext'
import { loadFrontendDicomIntoCornerstone, createCornerstoneStack } from '../utils/cornerstoneVolumeLoader'
import { initializeCornerstone } from '../utils/cornerstoneInit'
import { fetchDicomFiles, fetchDicomMetadata, getDicomFileUrl, fetchReconstructedDicomFiles } from '../api/backend'

const BASE_URL = ''
import { Toast } from './Toast'
import AnnotationLayer from './AnnotationLayer'
import { Annotation, AnnotationType } from '../types/annotations'

interface DicomMetadata {
  modality: string
  rows: number
  cols: number
  num_slices: number
  pixel_spacing: [number, number]
  slice_thickness: number
  z_spacing: number
  z_positions: number[]
  window: { center: number; width: number }
  rescale: { slope: number; intercept: number }
  uids: { patient_id: string; study_uid: string; series_uid: string }
}

interface DICOMViewerProps {
  caseId: string
  /**
   * When false, the component stays mounted but will not initialize/load Cornerstone.
   * This prevents losing the stack when switching UI tabs (we just hide/show the viewer).
   */
  isActive?: boolean
  /** Token to trigger reloading reconstructed DICOM */
  reconRefreshToken?: number
}

type ToolType = 'windowLevel' | 'zoom' | 'pan' | 'scroll' | 'measure' | 'roi' | 'ellipticalRoi' | 'circleRoi' | 'arrowAnnotate' | 'probe' | 'angle' | AnnotationType
type ImageQuality = 'pixel-perfect' | 'smooth'
type MeasurementType = 'distance' | 'angle' | 'roi'

interface Measurement {
  id: string
  type: MeasurementType
  points: Array<{ x: number; y: number }>
  value?: number
  label?: string
}

/**
 * DICOM Viewer Component with Cornerstone-like tools
 * Tools: Window/Level, Zoom, Pan, Scroll
 */
const DICOMViewer = ({ caseId, isActive = true, reconRefreshToken }: DICOMViewerProps) => {
  const { addSlice } = useFilmingContext()
  const { volume, metadata: frontendMetadata, files: frontendFiles, isLoading: filesLoading } = useFrontendDicomContext()
  const currentSliceRef = useRef(0)
  const loadedStackKeyRef = useRef<string | null>(null)
  const baseParallelScaleRef = useRef<number | null>(null)
  const hasRefreshedAfterTabSwitchRef = useRef(false)
  
  // State - Cornerstone3D only
  const [currentSlice, setCurrentSlice] = useState(0)
  const [totalSlices, setTotalSlices] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fps, setFps] = useState(10)
  
  // Reset state when case or local files change (but keep viewport initialized)
  useEffect(() => {
    const filesCount = frontendFiles?.length || 0
    console.log(`[DICOMViewer] Case/files changed: caseId=${caseId}, files=${filesCount}`)
    // Clear previous data
    setCurrentSlice(0)
    setTotalSlices(0)
    setError(null)
    setMetadata(null)
    loadedStackKeyRef.current = null
    // IMPORTANT: Don't reset cornerstoneInitializedRef or renderingEngineRef
    // This prevents viewport from disappearing during re-renders
    
    // Stop any running playback
    if (playIntervalRef.current) {
      clearInterval(playIntervalRef.current)
      playIntervalRef.current = null
      setIsPlaying(false)
    }
  }, [caseId, frontendFiles?.length])
  const [isPlaying, setIsPlaying] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  
  // DICOM metadata state
  const [metadata, setMetadata] = useState<DicomMetadata | null>(null)
  
  // Tool state
  const [activeTool, setActiveTool] = useState<ToolType>('windowLevel')
  const [windowWidth, setWindowWidth] = useState(400)
  const [windowCenter, setWindowCenter] = useState(40)
  const [zoom, setZoom] = useState(1)
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)
  const [isInverted, setIsInverted] = useState(false)
  const [imageQuality, setImageQuality] = useState<ImageQuality>('pixel-perfect')
  
  // Pixel value display
  const [pixelInfo, setPixelInfo] = useState<{ x: number; y: number; pixelX: number; pixelY: number } | null>(null)
  const [huValue, setHUValue] = useState<{ hu_value: number; tissue_type: string } | null>(null)
  const [loadingHU, setLoadingHU] = useState(false)
  const huFetchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    currentSliceRef.current = currentSlice
  }, [currentSlice])

  const fitToScreen = useCallback(() => {
    try {
      const viewport = renderingEngineRef.current?.getViewport?.('dicom-viewer-viewport') as any
      if (!viewport) return
      if (typeof viewport.resetCamera === 'function') {
        viewport.resetCamera()
      }
      // Capture "fit" scale as our zoom=1 baseline
      const camera = viewport.getCamera?.()
      if (camera?.parallelScale) {
        baseParallelScaleRef.current = camera.parallelScale
      }
      viewport.render?.()
      setZoom(1)
      setPanX(0)
      setPanY(0)
    } catch {
      // no-op
    }
  }, [])
  
  // Measurement tools
  const [measurements, setMeasurements] = useState<Measurement[]>([])
  const [currentMeasurement, setCurrentMeasurement] = useState<Measurement | null>(null)
  
  // Annotation tools
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [activeAnnotation, setActiveAnnotation] = useState<Annotation | null>(null)
  const [annotationColor, setAnnotationColor] = useState('#3b82f6')
  
  // 4-Window view state
  const [show4WindowView, setShow4WindowView] = useState(false)
  
  // Drag state
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [dragStartValues, setDragStartValues] = useState({ ww: 400, wc: 40, panX: 0, panY: 0, zoom: 1 })
  
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLDivElement>(null)
  const playIntervalRef = useRef<NodeJS.Timeout | null>(null)
  
  // Cornerstone3D refs
  const cornerstoneViewportRef = useRef<HTMLDivElement>(null)
  const renderingEngineRef = useRef<any>(null)
  const cornerstoneImageIdsRef = useRef<string[]>([])
  const cornerstoneInitializedRef = useRef(false)
  const fourWindowViewportsReadyRef = useRef(false)
  const zoomUpdateRef = useRef(false) // Flag to prevent zoom update feedback loop

  // Custom canvas rendering ref (workaround for Cornerstone3D rendering issues)
  const customCanvasRef = useRef<HTMLCanvasElement | null>(null)
  
  // Helper function to set up custom canvas rendering
  const setupCustomCanvas = useCallback((container: HTMLDivElement | null, imageId: string, csCore: any): HTMLCanvasElement | null => {
    if (!container) return null
    
    try {
      const cachedImage = csCore.cache.getImage(imageId)
      if (!cachedImage) {
        console.warn('[DICOMViewer] Image not in cache:', imageId)
        return null
      }
      
      const rows = cachedImage.rows || cachedImage.height
      const cols = cachedImage.columns || cachedImage.width
      
      // Create or reuse canvas
      let canvas = container.querySelector('.custom-dicom-canvas') as HTMLCanvasElement
      if (!canvas) {
        canvas = document.createElement('canvas')
        canvas.className = 'custom-dicom-canvas'
        canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;'
        container.appendChild(canvas)
      }
      
      canvas.width = cols
      canvas.height = rows
      
      console.log('[DICOMViewer] Custom canvas ready:', cols, 'x', rows)
      return canvas
    } catch (err) {
      console.error('[DICOMViewer] Failed to setup custom canvas:', err)
      return null
    }
  }, [])

  // Render image to custom canvas with zoom and pan
  const renderToCustomCanvas = useCallback((sliceIndex: number, ww: number, wc: number, invert: boolean = false, currentZoom: number = 1, currentPanX: number = 0, currentPanY: number = 0) => {
    const canvas = customCanvasRef.current
    const imageIds = cornerstoneImageIdsRef.current
    
    if (!canvas || imageIds.length === 0 || sliceIndex < 0 || sliceIndex >= imageIds.length) {
      return
    }
    
    const imageId = imageIds[sliceIndex]
    
    import('@cornerstonejs/core').then(csCore => {
      const cachedImage = csCore.cache.getImage(imageId)
      if (!cachedImage) {
        // Image not cached yet, try to load it
        csCore.imageLoader.loadAndCacheImage(imageId).then((img: any) => {
          renderImageToCanvas(canvas, img, ww, wc, invert, currentZoom, currentPanX, currentPanY)
        }).catch((err: any) => {
          console.error('[DICOMViewer] Failed to load image:', err)
        })
      } else {
        renderImageToCanvas(canvas, cachedImage, ww, wc, invert, currentZoom, currentPanX, currentPanY)
      }
    })
  }, [])
  
  // Actual canvas rendering function with zoom and pan support
  const renderImageToCanvas = useCallback((canvas: HTMLCanvasElement, image: any, ww: number, wc: number, invert: boolean, currentZoom: number = 1, currentPanX: number = 0, currentPanY: number = 0) => {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    
    const pixelData = image.getPixelData()
    const rows = image.rows || image.height
    const cols = image.columns || image.width
    const slope = image.slope || 1
    const intercept = image.intercept || 0
    
    // Ensure canvas dimensions match image size (not viewport size)
    if (canvas.width !== cols || canvas.height !== rows) {
      canvas.width = cols
      canvas.height = rows
    }
    
    // Clear canvas with black background
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    
    const imageData = ctx.createImageData(cols, rows)
    const windowMin = wc - ww / 2
    const windowMax = wc + ww / 2
    
    for (let i = 0; i < pixelData.length; i++) {
      // Apply rescale: HU = pixel * slope + intercept
      const hu = pixelData[i] * slope + intercept
      
      // Apply window/level
      let gray: number
      if (hu <= windowMin) {
        gray = 0
      } else if (hu >= windowMax) {
        gray = 255
      } else {
        gray = Math.round(((hu - windowMin) / ww) * 255)
      }
      
      // Apply inversion
      if (invert) {
        gray = 255 - gray
      }
      
      const idx = i * 4
      imageData.data[idx] = gray     // R
      imageData.data[idx + 1] = gray // G
      imageData.data[idx + 2] = gray // B
      imageData.data[idx + 3] = 255  // A
    }
    
    ctx.putImageData(imageData, 0, 0)
    
    // Apply zoom and pan via CSS transform on the canvas element
    const container = canvas.parentElement
    if (container) {
      const containerRect = container.getBoundingClientRect()
      const centerX = containerRect.width / 2
      const centerY = containerRect.height / 2
      
      // Calculate transform origin at center
      const transformOriginX = centerX
      const transformOriginY = centerY
      
      // Apply CSS transform for zoom and pan
      canvas.style.transformOrigin = `${transformOriginX}px ${transformOriginY}px`
      canvas.style.transform = `translate(${currentPanX}px, ${currentPanY}px) scale(${currentZoom})`
      canvas.style.imageRendering = currentZoom >= 1 ? 'pixelated' : 'auto'
    }
  }, [])


  // Initialize Cornerstone3D viewport
  const initializeCornerstoneViewport = useCallback(async () => {
    // Don't initialize twice
    if (cornerstoneInitializedRef.current) {
      console.log('[DICOMViewer] Cornerstone already initialized')
      return
    }

    // Store element reference early to prevent it from being lost
    const viewportElement = cornerstoneViewportRef.current
    if (!viewportElement || !document.contains(viewportElement)) {
      throw new Error('Viewport element not available in DOM')
    }

    // Wait for viewport to have proper dimensions (up to 3 seconds)
    let rect = viewportElement.getBoundingClientRect()
    let waitAttempts = 0
    const maxWaitAttempts = 15
    while ((rect.width === 0 || rect.height < 100) && waitAttempts < maxWaitAttempts) {
      console.log(`[DICOMViewer] Waiting for viewport dimensions... (${rect.width}x${rect.height})`)
      await new Promise(resolve => setTimeout(resolve, 200))
      rect = viewportElement.getBoundingClientRect()
      waitAttempts++
    }
    
    if (rect.width === 0 || rect.height < 100) {
      console.error(`[DICOMViewer] Viewport element has invalid size after waiting: ${rect.width}x${rect.height}`)
      throw new Error(`Viewport element has invalid size: ${rect.width}x${rect.height}`)
    }
    
    console.log(`[DICOMViewer] Viewport has valid dimensions: ${rect.width}x${rect.height}`)

    try {
      console.log('[DICOMViewer] Initializing Cornerstone3D viewport...')
      
      // Initialize Cornerstone
      await initializeCornerstone()
      
      const csCore = await import('@cornerstonejs/core')
      const csTools = await import('@cornerstonejs/tools')
      
      const { RenderingEngine, Enums } = csCore as any
      const { 
        ZoomTool, WindowLevelTool, PanTool, StackScrollTool, StackScrollMouseWheelTool,
        LengthTool, RectangleROITool, EllipticalROITool, CircleROITool,
        ArrowAnnotateTool, ProbeTool, AngleTool, TextAnnotationTool,
        ToolGroupManager, Enums: ToolsEnums, addTool, annotation 
      } = csTools as any

      // CRITICAL: Register tools before adding to tool group
      // Even though they're registered in cornerstoneInit, ensure they're registered here too
      // Register each tool individually to catch any failures
      const registerTool = (tool: any, name: string) => {
        if (!tool) return false
        try {
          addTool(tool)
          console.log(`[DICOMViewer] ✅ Registered ${name} during initialization`)
          return true
        } catch (e: any) {
          if (e?.message?.includes('already') || e?.message?.includes('exists')) {
            console.log(`[DICOMViewer] ${name} already registered (good)`)
            return true
          }
          console.warn(`[DICOMViewer] ⚠️ Failed to register ${name}:`, e?.message || e)
          return false
        }
      }
      
      if (typeof addTool === 'function') {
        registerTool(ZoomTool, 'ZoomTool')
        registerTool(WindowLevelTool, 'WindowLevelTool')
        registerTool(PanTool, 'PanTool')
        if (StackScrollTool) registerTool(StackScrollTool, 'StackScrollTool')
        if (StackScrollMouseWheelTool) registerTool(StackScrollMouseWheelTool, 'StackScrollMouseWheelTool')
        // Register annotation tools
        registerTool(LengthTool, 'LengthTool')
        registerTool(RectangleROITool, 'RectangleROITool')
        registerTool(EllipticalROITool, 'EllipticalROITool')
        registerTool(CircleROITool, 'CircleROITool')
        registerTool(ArrowAnnotateTool, 'ArrowAnnotateTool')
        registerTool(ProbeTool, 'ProbeTool')
        registerTool(AngleTool, 'AngleTool')
        // Text annotation disabled for now
        console.log('[DICOMViewer] Tool registration complete (including all annotation tools)')
      }

      // Verify element still exists - use stored reference
      if (!viewportElement || !document.contains(viewportElement)) {
        throw new Error('Viewport element disappeared during initialization')
      }

      // Create rendering engine
      const renderingEngineId = 'dicom-viewer-rendering-engine'
      const renderingEngine = new RenderingEngine(renderingEngineId)
      renderingEngineRef.current = renderingEngine

      // Create tool group
      const toolGroupId = 'dicom-viewer-tool-group'
      let toolGroup = ToolGroupManager.getToolGroup(toolGroupId)
      if (!toolGroup) {
        toolGroup = ToolGroupManager.createToolGroup(toolGroupId)
      }
      
      // Always ensure tools are added to tool group (even if group already exists)
      // Add tools to tool group by name (not class) - must be registered first via addTool
      try {
        toolGroup.addTool(ZoomTool.toolName)
      } catch (e) {
        // Tool already added, ignore
      }
      try {
        toolGroup.addTool(WindowLevelTool.toolName)
      } catch (e) {
        // Tool already added, ignore
      }
      try {
        toolGroup.addTool(PanTool.toolName)
      } catch (e) {
        // Tool already added, ignore
      }
      if (StackScrollTool) {
        try {
          toolGroup.addTool(StackScrollTool.toolName)
        } catch (e) {
          // Tool already added, ignore
        }
      }
      if (StackScrollMouseWheelTool) {
        try {
          toolGroup.addTool(StackScrollMouseWheelTool.toolName)
        } catch (e) {
          // Tool already added, ignore
        }
      }
      
      // Add annotation tools to tool group
      // Helper to add tool to group with proper error handling
      const addToolToGroup = (tool: any, name: string) => {
        if (!tool) return
        try {
          // Ensure tool is registered first
          try {
            addTool(tool)
          } catch (e: any) {
            // Already registered is fine
            if (!e?.message?.includes('already')) {
              console.warn(`[DICOMViewer] Warning registering ${name}:`, e)
            }
          }
          // Try adding by tool class first
          try {
            toolGroup.addTool(tool)
            console.log(`[DICOMViewer] ✅ ${name} added to tool group (by class)`)
          } catch (e1: any) {
            // If that fails, try by tool name
            try {
              toolGroup.addTool(tool.toolName)
              console.log(`[DICOMViewer] ✅ ${name} added to tool group (by name)`)
            } catch (e2: any) {
              if (e2?.message?.includes('already') || e2?.message?.includes('exists')) {
                console.log(`[DICOMViewer] ${name} already in tool group`)
              } else if (e2?.message?.includes('not registered')) {
                console.error(`[DICOMViewer] ❌ ${name} not registered - cannot add to tool group`)
              } else {
                console.warn(`[DICOMViewer] ⚠️ ${name} failed to add to tool group:`, e2)
              }
            }
          }
        } catch (e) {
          console.warn(`[DICOMViewer] Error with ${name}:`, e)
        }
      }
      
      addToolToGroup(LengthTool, 'LengthTool')
      addToolToGroup(RectangleROITool, 'RectangleROITool')
      addToolToGroup(EllipticalROITool, 'EllipticalROITool')
      addToolToGroup(CircleROITool, 'CircleROITool')
      addToolToGroup(ArrowAnnotateTool, 'ArrowAnnotateTool')
      addToolToGroup(ProbeTool, 'ProbeTool')
      addToolToGroup(AngleTool, 'AngleTool')
      // Text annotation tool disabled
      
      // Configure ZoomTool with proper settings for StackViewport
      toolGroup.setToolConfiguration(ZoomTool.toolName, {
        minZoom: 0.1,
        maxZoom: 10,
        preventZoomOutsideImage: false,
      })
      console.log('[DICOMViewer] ZoomTool configured with minZoom: 0.1, maxZoom: 10')
      
      const MouseBindings = ToolsEnums?.MouseBindings || {}
      const primary = MouseBindings.Primary ?? 1
      
      // Set WindowLevelTool as default active tool with primary mouse button
      toolGroup.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: primary }] })
      
      // DISABLE StackScrollMouseWheelTool - we use custom handleWheel instead
      // This prevents double-handling of wheel events and zoom conflicts
      if (StackScrollMouseWheelTool) {
        toolGroup.setToolPassive(StackScrollMouseWheelTool.toolName)
        console.log('[DICOMViewer] StackScrollMouseWheelTool DISABLED (using custom wheel handler)')
      }
      
      console.log('[DICOMViewer] Annotation tools (Length, RectangleROI) added to tool group')

      // Create viewport
      const viewportId = 'dicom-viewer-viewport'
      const viewportInput = {
        viewportId,
        type: Enums.ViewportType.STACK,
        element: viewportElement, // Use stored reference
        defaultOptions: {
          background: [0, 0, 0] as [number, number, number],
        },
      }

      // Use setViewports for stability (matches `CornerstoneViewport.tsx`)
      renderingEngine.setViewports([viewportInput])
      
      // Ensure viewport is added to tool group (critical for annotation tools to work)
      try {
        toolGroup.addViewport(viewportId, renderingEngineId)
        console.log('[DICOMViewer] ✅ Viewport added to tool group:', viewportId)
      } catch (e) {
        // Viewport might already be added, but log it
        console.log('[DICOMViewer] Viewport already in tool group or error:', e)
        // Try to add it anyway - some versions might need this
        try {
          toolGroup.addViewport(viewportId, renderingEngineId)
        } catch (e2) {
          console.warn('[DICOMViewer] Could not add viewport to tool group:', e2)
        }
      }

      // CRITICAL: Force resize after enabling element to ensure proper dimensions
      // Wait multiple frames for the element to be properly set up and layout to settle
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve))
      }
      
      // Get final dimensions
      let finalRect = viewportElement.getBoundingClientRect()
      console.log('[DICOMViewer] Viewport dimensions after enableElement:', finalRect.width, 'x', finalRect.height)
      
      // If viewport still has invalid height, wait a bit more and check parent
      if (finalRect.height === 0 || finalRect.height < 100) {
        console.warn('[DICOMViewer] Viewport has invalid height, checking parent container...')
        const parent = viewportElement.parentElement
        if (parent) {
          const parentRect = parent.getBoundingClientRect()
          console.log('[DICOMViewer] Parent container dimensions:', parentRect.width, 'x', parentRect.height)
          
          // Wait a bit more for layout
          await new Promise(resolve => setTimeout(resolve, 100))
          finalRect = viewportElement.getBoundingClientRect()
          console.log('[DICOMViewer] Viewport dimensions after wait:', finalRect.width, 'x', finalRect.height)
        }
      }
      
      // Force resize if dimensions are valid
      if (finalRect.width > 0 && finalRect.height > 0) {
        renderingEngine.resize(true, true)
        console.log('[DICOMViewer] Forced viewport resize')
      } else {
        console.warn('[DICOMViewer] Viewport still has invalid dimensions after initialization:', finalRect.width, 'x', finalRect.height)
        // Try one more resize after a delay
        setTimeout(() => {
          if (renderingEngineRef.current) {
            const checkRect = viewportElement.getBoundingClientRect()
            if (checkRect.width > 0 && checkRect.height > 0) {
              renderingEngineRef.current.resize(true, true)
              console.log('[DICOMViewer] Delayed viewport resize successful')
            }
          }
        }, 500)
      }

      cornerstoneInitializedRef.current = true
      console.log('[DICOMViewer] Cornerstone3D viewport initialized successfully')
    } catch (err) {
      console.error('[DICOMViewer] Failed to initialize Cornerstone:', err)
      setError(`Failed to initialize Cornerstone: ${err instanceof Error ? err.message : 'Unknown error'}`)
      throw err
    }
  }, [])

  // Initialize 4-window viewports when enabled
  useEffect(() => {
    if (!show4WindowView || !cornerstoneInitializedRef.current || !renderingEngineRef.current || totalSlices === 0) {
      return
    }

    const init4WindowViewports = async () => {
      try {
        const csCore = await import('@cornerstonejs/core')
        const { Enums } = csCore
        const renderingEngine = renderingEngineRef.current
        if (!renderingEngine) return

        // Get imageIds directly from ref (more reliable than getting from viewport)
        const imageIds = cornerstoneImageIdsRef.current
        if (!imageIds || imageIds.length === 0) {
          console.warn('[DICOMViewer] No imageIds available for 4-window view')
          return
        }

        // Wait for DOM elements to be ready
        await new Promise(resolve => setTimeout(resolve, 300))

        // Create 4 viewports for each window preset
        const viewportInputs = windowPresets.map((preset) => {
          const viewportId = `dicom-viewer-viewport-${preset.name.toLowerCase().replace(' ', '-')}`
          const element = document.getElementById(viewportId)
          if (!element) {
            console.warn(`[DICOMViewer] Element not found for viewport: ${viewportId}`)
            return null
          }

          return {
            viewportId,
            type: Enums.ViewportType.STACK,
            element,
            defaultOptions: {
              background: [0, 0, 0] as [number, number, number],
            },
          }
        }).filter(Boolean) as any[]

        if (viewportInputs.length === 0) {
          console.warn('[DICOMViewer] No viewport elements found for 4-window view')
          return
        }

        // Create viewports - include main viewport too so it's always available
        const mainViewportElement = document.getElementById('dicom-viewer-viewport')
        const allViewportInputs = [...viewportInputs]
        
        // Ensure main viewport is also in the rendering engine (even if hidden)
        if (mainViewportElement) {
          const mainViewportExists = renderingEngine.getViewport('dicom-viewer-viewport')
          if (!mainViewportExists) {
            allViewportInputs.push({
              viewportId: 'dicom-viewer-viewport',
              type: Enums.ViewportType.STACK,
              element: mainViewportElement,
              defaultOptions: {
                background: [0, 0, 0] as [number, number, number],
              },
            })
          }
        }
        
        // Create all viewports (4-window + main)
        renderingEngine.setViewports(allViewportInputs)

        // Wait for viewports to be created and enabled
        await new Promise(resolve => setTimeout(resolve, 200))

        // Load stack into each viewport with different window/level
        const initPromises = viewportInputs.map(async (input) => {
          const vp = renderingEngine.getViewport(input.viewportId) as any
          if (!vp) {
            console.warn(`[DICOMViewer] Viewport not found: ${input.viewportId}`)
            return false
          }

          const preset = windowPresets.find(p => 
            input.viewportId.includes(p.name.toLowerCase().replace(' ', '-'))
          )
          if (!preset) return false

          try {
            // Set stack with current slice
            await vp.setStack(imageIds, currentSlice)
            
            // Wait for stack to be set
            await new Promise(resolve => setTimeout(resolve, 100))
            
            // Calculate VOI range from window/level (this is the correct way for Cornerstone3D)
            const lower = preset.center - preset.width / 2
            const upper = preset.center + preset.width / 2
            
            // Apply window/level using voiRange (same as main viewport)
            vp.setProperties({
              voiRange: { lower, upper }
            })
            
            // Also call setVOI if available
            if (typeof vp.setVOI === 'function') {
              vp.setVOI({ lower, upper })
            }
            
            // Force resize and render
            if (typeof vp.resize === 'function') {
              vp.resize()
            }
            vp.render()
            
            // Force another render after a delay to ensure image appears
            setTimeout(() => {
              // Re-apply window/level to ensure it sticks
              vp.setProperties({
                voiRange: { lower, upper }
              })
              if (typeof vp.setVOI === 'function') {
                vp.setVOI({ lower, upper })
              }
              vp.render()
            }, 200)
            
            console.log(`[DICOMViewer] ✅ Initialized viewport: ${preset.name}`)
            return true
          } catch (err) {
            console.error(`[DICOMViewer] Failed to initialize viewport ${preset.name}:`, err)
            return false
          }
        })

        // Wait for all viewports to initialize
        await Promise.all(initPromises)

        // Final resize of rendering engine
        renderingEngine.resize(true, true)
        
        // Mark 4-window viewports as ready
        fourWindowViewportsReadyRef.current = true
        
        console.log('[DICOMViewer] ✅ Initialized all 4-window viewports')
      } catch (err) {
        console.error('[DICOMViewer] Failed to initialize 4-window viewports:', err)
        fourWindowViewportsReadyRef.current = false
      }
    }

    // Reset ready flag when entering 4-window view
    fourWindowViewportsReadyRef.current = false
    
    // Wait for DOM to be ready
    setTimeout(init4WindowViewports, 100)
  }, [show4WindowView, totalSlices])

  // Update all 4-window viewports when slice changes
  useEffect(() => {
    if (!show4WindowView || !renderingEngineRef.current || totalSlices === 0) {
      return
    }

    const update4WindowSlices = async () => {
      try {
        // Wait for viewports to be initialized
        if (!fourWindowViewportsReadyRef.current) {
          // Wait a bit and retry
          await new Promise(resolve => setTimeout(resolve, 200))
          if (!fourWindowViewportsReadyRef.current) {
            // Still not ready, skip this update
            return
          }
        }

        const renderingEngine = renderingEngineRef.current
        if (!renderingEngine) return

        const imageIds = cornerstoneImageIdsRef.current
        if (!imageIds || imageIds.length === 0) {
          return
        }

        // Update each 4-window viewport
        for (const preset of windowPresets) {
          const viewportId = `dicom-viewer-viewport-${preset.name.toLowerCase().replace(' ', '-')}`
          const vp = renderingEngine.getViewport(viewportId) as any
          if (!vp) {
            // Viewport might not be ready yet, skip silently (will be updated on next slice change)
            continue
          }

          try {
            // Update slice - prefer setImageIdIndex for performance
            if (typeof vp.setImageIdIndex === 'function') {
              vp.setImageIdIndex(currentSlice)
            } else {
              // Fallback: set stack again
              await vp.setStack(imageIds, currentSlice)
            }
            
            // Calculate VOI range from window/level
            const lower = preset.center - preset.width / 2
            const upper = preset.center + preset.width / 2
            
            // Ensure window/level is still applied (in case it was reset)
            vp.setProperties({
              voiRange: { lower, upper }
            })
            
            // Also call setVOI if available
            if (typeof vp.setVOI === 'function') {
              vp.setVOI({ lower, upper })
            }
            
            // Render the viewport
            vp.render()
          } catch (err) {
            console.warn(`[DICOMViewer] Failed to update viewport ${preset.name}:`, err)
          }
        }
      } catch (err) {
        console.error('[DICOMViewer] Failed to update 4-window slices:', err)
      }
    }

    // Update slices - the function already handles waiting for viewports
    update4WindowSlices()
  }, [show4WindowView, currentSlice, totalSlices])

  // Track previous 4-window view state to detect exit
  const prevShow4WindowViewRef = useRef<boolean | null>(null)

  // Cleanup and restore main viewport when exiting 4-window view
  useEffect(() => {
    // Only restore when transitioning from 4-window view to single view
    const wasIn4Window = prevShow4WindowViewRef.current === true
    const isIn4Window = show4WindowView === true
    
    // Only update ref if state actually changed
    if (prevShow4WindowViewRef.current !== show4WindowView) {
      prevShow4WindowViewRef.current = show4WindowView
    }

    // Only run restoration when exiting 4-window view (was true, now false)
    // Also skip if this is the first render (ref is null)
    if (prevShow4WindowViewRef.current === null || !wasIn4Window || isIn4Window || !renderingEngineRef.current || totalSlices === 0) {
      return
    }

    // Reset 4-window ready flag when exiting
    fourWindowViewportsReadyRef.current = false

    // When exiting 4-window view, ensure main viewport is visible and rendered
    const restoreMainViewport = async () => {
      try {
        const renderingEngine = renderingEngineRef.current
        if (!renderingEngine) return

        // Wait for DOM to update and viewport element to be visible
        await new Promise(resolve => setTimeout(resolve, 200))

        // Check if main viewport element exists and is visible
        const viewportElement = document.getElementById('dicom-viewer-viewport')
        if (!viewportElement) {
          console.warn('[DICOMViewer] Main viewport element not found')
          return
        }

        const rect = viewportElement.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
          console.warn('[DICOMViewer] Main viewport element has zero dimensions, waiting...')
          await new Promise(resolve => setTimeout(resolve, 200))
        }

        const mainViewport = renderingEngine.getViewport('dicom-viewer-viewport') as any
        if (!mainViewport) {
          console.warn('[DICOMViewer] Main viewport not found in rendering engine, creating it...')
          // Try to create the main viewport if it doesn't exist
          try {
            const csCore = await import('@cornerstonejs/core')
            const { Enums } = csCore
            const viewportInput = {
              viewportId: 'dicom-viewer-viewport',
              type: Enums.ViewportType.STACK,
              element: viewportElement,
              defaultOptions: {
                background: [0, 0, 0] as [number, number, number],
              },
            }
            renderingEngine.setViewports([viewportInput])
            await new Promise(resolve => setTimeout(resolve, 100))
            const newViewport = renderingEngine.getViewport('dicom-viewer-viewport') as any
            if (!newViewport) {
              console.error('[DICOMViewer] Failed to create main viewport')
              return
            }
            // Set stack on newly created viewport
            const imageIds = cornerstoneImageIdsRef.current
            if (imageIds && imageIds.length > 0) {
              await newViewport.setStack(imageIds, currentSlice)
              newViewport.render()
            }
            console.log('[DICOMViewer] ✅ Created and restored main viewport')
            return
          } catch (e) {
            console.error('[DICOMViewer] Failed to create main viewport:', e)
            return
          }
        }

        // Ensure main viewport has the current slice
        const imageIds = cornerstoneImageIdsRef.current
        if (imageIds && imageIds.length > 0) {
          const stack = mainViewport.getStack?.()
          if (!stack || !stack.imageIds || stack.imageIds.length === 0) {
            // Re-set stack if it was lost
            console.log('[DICOMViewer] Re-setting stack on main viewport')
            await mainViewport.setStack(imageIds, currentSlice)
            await new Promise(resolve => setTimeout(resolve, 100))
          } else {
            // Just update the slice index
            if (typeof mainViewport.setImageIdIndex === 'function') {
              mainViewport.setImageIdIndex(currentSlice)
            }
          }
        }

        // Resize rendering engine first
        renderingEngine.resize(true, true)
        
        // Wait for resize
        await new Promise(resolve => setTimeout(resolve, 50))
        
        // Render main viewport
        mainViewport.render()
        
        // Force another render after a short delay
        setTimeout(() => {
          mainViewport.render()
          renderingEngine.resize(true, true)
        }, 100)
        
        console.log('[DICOMViewer] ✅ Restored main viewport after exiting 4-window view')
      } catch (err) {
        console.error('[DICOMViewer] Failed to restore main viewport:', err)
      }
    }

    restoreMainViewport()
  }, [show4WindowView, totalSlices])

  // Load DICOM files into Cornerstone
  const loadDicomIntoCornerstone = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return
    }

    try {
      // Extract ONLY real File/Blob objects - Cornerstone requires actual File/Blob objects
      // Validate each file to ensure it implements the Blob interface
      const realFiles: File[] = []
      
      for (let i = 0; i < files.length; i++) {
        const f: any = files[i]
        
        // Check if it's a wrapped object with a 'file' property
        if (f && typeof f === 'object' && 'file' in f) {
          const extractedFile = f.file
          if (extractedFile instanceof File) {
            realFiles.push(extractedFile)
            continue
          }
          if (extractedFile instanceof Blob && !(extractedFile instanceof File)) {
            // Convert Blob to File
            const fileName = (extractedFile as any).name || `dicom_${i}.dcm`
            const file = new File([extractedFile], fileName, { type: extractedFile.type || 'application/dicom' })
            realFiles.push(file)
            continue
          }
        }
        
        // Check if it's already a File
        if (f instanceof File) {
          realFiles.push(f)
          continue
        }
        
        // Check if it's a Blob (but not File)
        if (f instanceof Blob && !(f instanceof File)) {
          // Create File from Blob
          const fileName = (f as any).name || `dicom_${i}.dcm`
          const file = new File([f], fileName, { type: f.type || 'application/dicom' })
          realFiles.push(file)
          continue
        }
        
        // Log invalid file for debugging
        console.warn(`[DICOMViewer] Invalid file at index ${i}:`, {
          type: typeof f,
          isFile: f instanceof File,
          isBlob: f instanceof Blob,
          hasFile: f && typeof f === 'object' && 'file' in f,
          constructor: f?.constructor?.name,
          keys: f && typeof f === 'object' ? Object.keys(f) : []
        })
      }
      
      if (realFiles.length === 0) {
        throw new Error('No valid File objects found in frontendFiles')
      }
      
      if (realFiles.length !== files.length) {
        console.warn(`[DICOMViewer] Filtered ${files.length - realFiles.length} invalid file objects (${realFiles.length} valid)`)
      }
      
      // Final validation: ensure all files are valid File instances
      // Since realFiles is already File[], we just verify they're all valid
      for (let i = 0; i < realFiles.length; i++) {
        const f = realFiles[i]
        if (!(f instanceof File)) {
          console.error(`[DICOMViewer] File at index ${i} is not a valid File instance:`, {
            type: typeof f,
            constructor: (f as any)?.constructor?.name
          })
          throw new Error(`File at index ${i} is not a valid File instance`)
        }
      }
      
      console.log(`[DICOMViewer] Loading ${realFiles.length} validated DICOM files into Cornerstone`)
      
      // Load files into Cornerstone
      const { imageIds } = await loadFrontendDicomIntoCornerstone(realFiles)
      
      // Sort by Z position
      const sortedImageIds = await createCornerstoneStack(imageIds)
      cornerstoneImageIdsRef.current = sortedImageIds
      
      console.log(`[DICOMViewer] Loaded ${sortedImageIds.length} images into Cornerstone`)
      
      // Set total slices - CRITICAL: This must be set for slice navigation to work
      setTotalSlices(sortedImageIds.length)
      setCurrentSlice(0)
      console.log(`[DICOMViewer] Total slices set to: ${sortedImageIds.length}`)
      
      // Wait for viewport to be ready AND properly sized
      if (!renderingEngineRef.current) {
        console.warn('[DICOMViewer] Rendering engine not ready, waiting...')
        let retries = 0
        while (!renderingEngineRef.current && retries < 20) {
          await new Promise(resolve => setTimeout(resolve, 100))
          retries++
        }
      }
      
      // CRITICAL: Ensure viewport element has proper size before loading images
      // Cornerstone needs the element to have dimensions to create proper canvas
      const viewportElement = cornerstoneViewportRef.current
      if (viewportElement) {
        const rect = viewportElement.getBoundingClientRect()
        console.log('[DICOMViewer] Viewport element size before image load:', rect.width, 'x', rect.height)
        
        // If viewport is too small, wait a bit for layout to settle
        if (rect.width < 100 || rect.height < 100) {
          console.warn('[DICOMViewer] Viewport element is too small, waiting for layout...')
          await new Promise(resolve => setTimeout(resolve, 200))
          
          // Check again
          const newRect = viewportElement.getBoundingClientRect()
          console.log('[DICOMViewer] Viewport element size after wait:', newRect.width, 'x', newRect.height)
          
          // Force resize if still small
          if (newRect.width < 100 || newRect.height < 100) {
            console.warn('[DICOMViewer] Viewport still too small, forcing resize...')
            if (renderingEngineRef.current) {
              renderingEngineRef.current.resize(true, true)
            }
          }
        }
      }
      
      // Set stack ONCE with all imageIds (following Cornerstone3D recommended pattern)
      if (renderingEngineRef.current && sortedImageIds.length > 0) {
        const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
        if (!viewport) {
          throw new Error('Viewport not found')
        }
        
        // Pre-load the first image to verify our loader works
        const csCore = await import('@cornerstonejs/core')
        console.log('[DICOMViewer] Pre-loading first image:', sortedImageIds[0])
        try {
          const firstImage = await csCore.imageLoader.loadAndCacheImage(sortedImageIds[0])
          console.log('[DICOMViewer] First image loaded successfully:', {
            width: firstImage.width,
            height: firstImage.height,
            minPixelValue: firstImage.minPixelValue,
            maxPixelValue: firstImage.maxPixelValue,
          })
        } catch (loadErr) {
          console.error('[DICOMViewer] Failed to pre-load first image:', loadErr)
        }
        
        // Set stack with initial index (recommended pattern: viewport.setStack(imageIds, initialIndex))
        await viewport.setStack(sortedImageIds, 0)
        
        // Force render after stack is set
        await new Promise(resolve => requestAnimationFrame(resolve))
        viewport.render()
        
        // Set initial window/level based on HU values (after rescale)
        try {
          // Get the first image to check its pixel range
          const firstImageId = sortedImageIds[0]
          const cachedImage = csCore.cache.getImage(firstImageId)
          
          // Default CT soft tissue window
          let ww = 400
          let wc = 40
          
          if (cachedImage) {
            const imgWW = cachedImage.windowWidth
            const imgWC = cachedImage.windowCenter
            const minPx = cachedImage.minPixelValue
            const maxPx = cachedImage.maxPixelValue
            const slope = cachedImage.slope || 1
            const intercept = cachedImage.intercept || 0
            
            console.log('[DICOMViewer] Image properties:', { imgWW, imgWC, minPx, maxPx, slope, intercept })
            
            // Calculate HU values (window/level must be in HU space, not raw pixel space)
            const minHU = minPx * slope + intercept
            const maxHU = maxPx * slope + intercept
            
            console.log('[DICOMViewer] HU range:', { minHU, maxHU })
            
            // CRITICAL: Window/level must be in HU space (after rescale applied)
            // Use DICOM-provided window values if they're reasonable
            if (imgWW && imgWC && imgWW > 0) {
              ww = imgWW
              wc = imgWC
              console.log('[DICOMViewer] Using DICOM window values (HU space):', { ww, wc })
            } else {
              // Auto-calculate from HU range
              ww = maxHU - minHU
              wc = (maxHU + minHU) / 2
              console.log('[DICOMViewer] Auto-calculated window from HU range:', { ww, wc })
            }
          }
          
          // Ensure reasonable window values for CT
          if (ww <= 0) ww = 400
          if (wc < -2000 || wc > 4000) {
            // Window center outside typical range, use soft tissue default
            console.log('[DICOMViewer] Window center outside typical range, using soft tissue default')
            ww = 400
            wc = 40
          }
          
          // Apply initial VOI using both APIs to be robust across Cornerstone3D versions
          // VOI range in HU: lower = WC - WW/2, upper = WC + WW/2
          const lower = wc - ww / 2
          const upper = wc + ww / 2

          // 1) Always set voiRange (works for StackViewport)
          viewport.setProperties({
            voiRange: { lower, upper }
          })
          console.log('[DICOMViewer] Set initial VOI via voiRange (HU space):', { lower, upper })

          // 2) Also call setVOI when available (some builds expect this)
          // StackViewport.setVOI expects a VOIRange { lower, upper }.
          if (typeof viewport.setVOI === 'function') {
            viewport.setVOI({ lower, upper })
            console.log('[DICOMViewer] Also set initial VOI via setVOI (voiRange):', { lower, upper })
          }

          viewport.render()
        } catch (voiErr) {
          console.warn('[DICOMViewer] Failed to set initial VOI:', voiErr)
        }
        
        console.log('[DICOMViewer] Stack set with', sortedImageIds.length, 'images, showing slice 0')
        
        // Get image window/level values for initial state
          const firstImage = csCore.cache.getImage(sortedImageIds[0])
          const imgWW = firstImage?.windowWidth || 1475
          const imgWC = firstImage?.windowCenter || 440
          
        // Update state with proper initial WW/WC
          setWindowWidth(imgWW)
          setWindowCenter(imgWC)
          
        console.log('[DICOMViewer] Using Cornerstone3D only - WW:', imgWW, 'WC:', imgWC)
      } else {
        console.warn('[DICOMViewer] Cannot load images: rendering engine or imageIds not available')
      }
    } catch (err) {
      console.error('[DICOMViewer] Failed to load DICOM into Cornerstone:', err)
      if (err instanceof Error) {
        console.error('[DICOMViewer] Error details:', {
          message: err.message,
          stack: err.stack,
          name: err.name
        })
      }
      throw err
    }
  }, [])

  // Load DICOM files into Cornerstone3D
  const loadDicomData = useCallback(async () => {
    setLoading(true)
    setError(null)
    
    try {
      // Ensure Cornerstone viewport exists
      if (!cornerstoneInitializedRef.current) {
        await initializeCornerstoneViewport()
      }

      let initRetries = 0
      while (!cornerstoneInitializedRef.current && initRetries < 20) {
        await new Promise(resolve => setTimeout(resolve, 50))
        initRetries++
      }

      if (!cornerstoneInitializedRef.current || !renderingEngineRef.current) {
        throw new Error('Cornerstone viewport not initialized')
      }

      // Option 1 (local upload) remains supported if frontend files exist
      if (frontendFiles && frontendFiles.length > 0) {
        if (!volume || !frontendMetadata) {
          throw new Error('Local DICOM files are present but volume/metadata are not ready yet')
        }

        console.log('[DICOMViewer] Loading local DICOM files into Cornerstone3D', {
          numFiles: frontendFiles.length,
          volumeShape: volume.shape,
          numSlices: frontendMetadata.numSlices,
        })

        await loadDicomIntoCornerstone(frontendFiles)
        return
      }

      // Option 2: backend streaming (wadouri)
      if (!caseId) {
        throw new Error('Please select a case first')
      }

      console.log('[DICOMViewer] Loading backend DICOM stack via wadouri:', { caseId })

      // ✅ CHECK FOR RECONSTRUCTED DICOM FIRST
      const reconData = await fetchReconstructedDicomFiles(caseId)
      let files: string[]
      let useReconstructed = false
      
      if (reconData.has_reconstruction && reconData.files.length > 0) {
        console.log('[DICOMViewer] Using reconstructed DICOM files:', reconData.files.length)
        files = reconData.files
        useReconstructed = true
      } else {
        console.log('[DICOMViewer] Using original DICOM files (no reconstruction found)')
        const dicomData = await fetchDicomFiles(caseId)
        files = dicomData.files
      }

      // Fetch metadata (will return reconstructed metadata if available)
      const meta = await fetchDicomMetadata(caseId)

      if (!files || files.length === 0) {
        throw new Error('No DICOM files found for selected case')
      }

      // Build imageIds - use reconstructed path if available
      const imageIds = files.map((filename) => {
        let url: string
        if (useReconstructed && reconData.recon_url) {
          // Use reconstructed DICOM URL path
          url = `${BASE_URL}${reconData.recon_url}/${filename}`
        } else {
          // Use original DICOM path
          url = getDicomFileUrl(caseId, filename)
        }
        return `wadouri:${url}`
      })

      cornerstoneImageIdsRef.current = imageIds
      setTotalSlices(imageIds.length)
      
      // ✅ Preserve current slice index when reloading (e.g., after reconstruction or tab switch)
      // Use ref to get current value (avoids stale closure issues)
      const currentSliceValue = currentSliceRef.current
      const preservedSlice = Math.max(0, Math.min(currentSliceValue, imageIds.length - 1))
      console.log('[DICOMViewer] Preserving slice:', { currentSliceValue, preservedSlice, totalImages: imageIds.length })
      setCurrentSlice(preservedSlice)
      currentSliceRef.current = preservedSlice

      // ✅ UPDATE METADATA WITH RECONSTRUCTED VALUES
      // The metadata endpoint now returns reconstructed metadata if available
      // Update num_slices to match actual reconstructed slice count
      const updatedMeta = {
        ...(meta as any),
        num_slices: imageIds.length,  // ✅ Use actual reconstructed slice count
        // slice_thickness is already correct from metadata endpoint (reconstructed value)
      }

      // If the series has rescale slope/intercept, our main-thread wadouri loader will apply it
      // and store HU pixels (slope=1, intercept=0). Normalize rescale to avoid double-conversion.
      const incomingSlope = updatedMeta?.rescale?.slope ?? 1
      const incomingIntercept = updatedMeta?.rescale?.intercept ?? 0
      const didConvertToHU = incomingSlope !== 1 || incomingIntercept !== 0
      setMetadata({
        ...updatedMeta,
        rescale: didConvertToHU ? { slope: 1, intercept: 0 } : { slope: incomingSlope, intercept: incomingIntercept },
      })
      if (updatedMeta?.window) {
        setWindowWidth(updatedMeta.window.width)
        setWindowCenter(updatedMeta.window.center)
      }

      // Ensure main viewport exists - if 4-window is active, we still need the main viewport for loading
      let viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
      if (!viewport) {
        // Main viewport might not exist if 4-window view is active
        // Try to create it temporarily
        const viewportElement = document.getElementById('dicom-viewer-viewport')
        if (viewportElement && renderingEngineRef.current) {
          try {
            const csCore = await import('@cornerstonejs/core')
            const { Enums } = csCore
            const viewportInput = {
              viewportId: 'dicom-viewer-viewport',
              type: Enums.ViewportType.STACK,
              element: viewportElement,
              defaultOptions: {
                background: [0, 0, 0] as [number, number, number],
              },
            }
            renderingEngineRef.current.setViewports([viewportInput])
            await new Promise(resolve => setTimeout(resolve, 100))
            viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
          } catch (e) {
            console.warn('[DICOMViewer] Failed to create main viewport:', e)
          }
        }
        
        if (!viewport) {
          throw new Error('Viewport not found - please exit 4-window view and try again')
        }
      }

      // Default to GPU rendering (VTK/WebGL). CPU fallback can be forced via `?cpu=1` if needed.
      const forceCpu = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('cpu') === '1'
      if (typeof viewport.setUseCPURendering === 'function') {
        viewport.setUseCPURendering(!!forceCpu)
        console.log(`[DICOMViewer] StackViewport rendering mode: ${forceCpu ? 'CPU' : 'GPU'}`)
      }

      // ✅ Use preserved slice index (already calculated above)
      const startIndex = preservedSlice
      await viewport.setStack(imageIds, startIndex)

      // Default behavior: fit slice to viewport on load
      try {
        if (typeof viewport.resetCamera === 'function') {
          viewport.resetCamera()
        }
        const camera = viewport.getCamera?.()
        if (camera?.parallelScale) {
          baseParallelScaleRef.current = camera.parallelScale
        }
      } catch {
        // ignore
      }

      // Debug: verify first image decodes and has non-zero pixel range
      try {
        const csCore = await import('@cornerstonejs/core')
        const first = await (csCore as any).imageLoader.loadAndCacheImage(imageIds[0])
        console.log('[DICOMViewer] First wadouri image loaded:', {
          imageId: imageIds[0],
          rows: first?.rows,
          columns: first?.columns,
          minPixelValue: first?.minPixelValue,
          maxPixelValue: first?.maxPixelValue,
          slope: first?.slope,
          intercept: first?.intercept,
          windowWidth: first?.windowWidth,
          windowCenter: first?.windowCenter,
        })
      } catch (e) {
        console.warn('[DICOMViewer] Failed to load first wadouri image for debug:', e)
      }

      if (meta?.window) {
        const lower = meta.window.center - meta.window.width / 2
        const upper = meta.window.center + meta.window.width / 2
        viewport.setProperties({ voiRange: { lower, upper } })
        // StackViewport.setVOI expects a VOIRange { lower, upper }.
        if (typeof viewport.setVOI === 'function') {
          viewport.setVOI({ lower, upper })
        }
      }

      viewport.render()
      console.log('[DICOMViewer] Backend stack loaded:', { slices: imageIds.length })

      // After layout settles (right panel / tabs), fit again so the slice is perfectly centered.
      // This avoids the slight off-center you can see right after case load.
      if (typeof window !== 'undefined') {
        requestAnimationFrame(() => {
          try {
            renderingEngineRef.current?.resize?.(true, true)
          } catch {
            // ignore
          }
          fitToScreen()
        })
      }
    } catch (e: any) {
      console.error('[DICOMViewer] Failed to load DICOM files:', e)
      setError(e?.message || 'Failed to load DICOM files')
    } finally {
      setLoading(false)
    }
  }, [caseId, volume, frontendMetadata, frontendFiles, initializeCornerstoneViewport, loadDicomIntoCornerstone, fitToScreen])

  // Handle viewport resize
  useEffect(() => {
    const viewportElement = cornerstoneViewportRef.current
    if (!viewportElement) return

    const handleResize = () => {
      const engine = renderingEngineRef.current
      if (!engine) return
      const rect = viewportElement.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        console.log('[DICOMViewer] Resizing viewport:', rect.width, 'x', rect.height)
        engine.resize(true, true)

        // If user is in "fit" zoom mode (zoom ~ 1 and no pan), keep the image centered on resize.
        try {
          const viewport = engine.getViewport?.('dicom-viewer-viewport') as any
          const pan = viewport?.getPan?.()
          const panIsZero = !pan || (Math.abs(pan[0]) < 1 && Math.abs(pan[1]) < 1)
          if (zoom === 1 && panIsZero && typeof viewport?.resetCamera === 'function') {
            viewport.resetCamera(true, true, true, true)
            const camera = viewport.getCamera?.()
            if (camera?.parallelScale) baseParallelScaleRef.current = camera.parallelScale
            viewport.render?.()
          }
        } catch {
          // ignore
        }
      }
    }

    // Use ResizeObserver to watch for size changes
    const resizeObserver = new ResizeObserver(() => handleResize())
    resizeObserver.observe(viewportElement)

    // Also listen to window resize
    window.addEventListener('resize', handleResize)
    // One immediate resize attempt (in case engine is already created)
    setTimeout(handleResize, 0)

    return () => {
      resizeObserver.unobserve(viewportElement)
      window.removeEventListener('resize', handleResize)
    }
  }, [caseId, zoom]) // Rerun when case/zoom changes (zoom==1 triggers fit-centering on resize)

  // Listen to Cornerstone3D VOI changes (from WindowLevelTool)
  useEffect(() => {
    let cleanup: (() => void) | null = null

    const setupEventListener = async () => {
      try {
        const csCore = await import('@cornerstonejs/core')
        const { eventTarget, EVENTS } = csCore as any
        
        // Handler for VOI modified event (window/level changes from Cornerstone3D tools)
        const handleVoiModified = (evt: any) => {
          const { detail } = evt
          if (detail?.viewportId === 'dicom-viewer-viewport' && detail?.range) {
            const { lower, upper } = detail.range
            const imageIds = cornerstoneImageIdsRef.current
            const currentImageId = imageIds?.[currentSlice] || imageIds?.[0] || ''
            const isWadouri = typeof currentImageId === 'string' && currentImageId.startsWith('wadouri:')

            const slope = metadata?.rescale?.slope ?? 1
            const intercept = metadata?.rescale?.intercept ?? 0
            const safeSlope = slope === 0 ? 1 : slope

            // Convert back to HU for the UI when streaming wadouri (stored -> HU)
            const lowerHU = isWadouri ? lower * safeSlope + intercept : lower
            const upperHU = isWadouri ? upper * safeSlope + intercept : upper

            const newWindowWidth = upperHU - lowerHU
            const newWindowCenter = (upperHU + lowerHU) / 2
            
            console.log('[DICOMViewer] CS3D VOI changed:', {
              lower,
              upper,
              lowerHU,
              upperHU,
              newWindowWidth,
              newWindowCenter,
              isWadouri,
            })
            
            // Update React state (this will trigger custom canvas re-render)
            setWindowWidth(Math.round(newWindowWidth))
            setWindowCenter(Math.round(newWindowCenter))
          }
        }

        // Handler for stack image change (slice navigation via scroll)
        const handleStackNewImage = (evt: any) => {
          const { detail } = evt
          if (detail?.viewportId === 'dicom-viewer-viewport' && detail?.imageIdIndex !== undefined) {
            const newSliceIndex = detail.imageIdIndex
            console.log('[DICOMViewer] CS3D slice changed:', newSliceIndex)
            
            // Update React state (this will trigger custom canvas re-render)
            setCurrentSlice(newSliceIndex)
          }
        }

        // Handler for camera modified event (zoom/pan changes from ZoomTool)
        // Only sync zoom when ZoomTool is active to prevent conflicts during slice changes
        const handleCameraModified = (evt: any) => {
          const { detail } = evt
          if (detail?.viewportId === 'dicom-viewer-viewport' && renderingEngineRef.current) {
            // Check if this is likely from ZoomTool interaction (has user interaction flag)
            // Skip sync if it's triggered by slice change or other programmatic updates
            const isUserInteraction = detail?.interaction || detail?.viewportId
            
            try {
              const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
              if (viewport && viewport.getCamera) {
                const camera = viewport.getCamera()
                if (camera && camera.parallelScale) {
                  // Calculate zoom from parallelScale
                  const viewportElement = cornerstoneViewportRef.current
                  if (viewportElement) {
                    const rect = viewportElement.getBoundingClientRect()
                    const viewportWidth = rect.width
                    const viewportHeight = rect.height
                    
                    if (viewportWidth > 0 && viewportHeight > 0) {
                      const fallbackBase = Math.max(viewportWidth, viewportHeight) / 2
                      const baseParallelScale =
                        baseParallelScaleRef.current ??
                        (viewport.getCamera?.()?.parallelScale ?? fallbackBase)
                      baseParallelScaleRef.current = baseParallelScale
                      const newZoom = baseParallelScale / camera.parallelScale
                      
                      // Only sync zoom from Cornerstone if significantly different AND looks like user interaction
                      // This prevents camera reset during slice changes from affecting our zoom state
                      setZoom(prev => {
                        const diff = Math.abs(prev - newZoom)
                        // Only update if difference is significant (>5%) to avoid feedback loops
                        // and to ignore minor camera adjustments during slice changes
                        if (diff > 0.05 && isUserInteraction) {
                          console.log('[DICOMViewer] CS3D zoom changed:', (newZoom * 100).toFixed(0) + '%')
                          zoomUpdateRef.current = true // Flag to prevent feedback loop
                          return newZoom
                        }
                        return prev
                      })
                    }
                  }
                }
              }
            } catch (err) {
              console.warn('[DICOMViewer] Failed to sync zoom from Cornerstone:', err)
            }
          }
        }

        // Subscribe to VOI_MODIFIED event
        if (eventTarget && EVENTS?.VOI_MODIFIED) {
          eventTarget.addEventListener(EVENTS.VOI_MODIFIED, handleVoiModified)
          console.log('[DICOMViewer] Subscribed to Cornerstone3D VOI_MODIFIED event')
        }
        
        // Subscribe to STACK_NEW_IMAGE event (slice changes)
        if (eventTarget && EVENTS?.STACK_NEW_IMAGE) {
          eventTarget.addEventListener(EVENTS.STACK_NEW_IMAGE, handleStackNewImage)
          console.log('[DICOMViewer] Subscribed to Cornerstone3D STACK_NEW_IMAGE event')
        }

        // Subscribe to CAMERA_MODIFIED event (zoom/pan changes from ZoomTool/PanTool)
        // Note: This event may not exist in all Cornerstone3D versions, so we check first
        if (eventTarget && EVENTS) {
          // Try different possible event names
          const cameraEvent = EVENTS.CAMERA_MODIFIED || EVENTS.CAMERA_MODIFIED_EVENT || 'cameraModified'
          if (typeof cameraEvent === 'string' || typeof cameraEvent === 'number') {
            try {
              eventTarget.addEventListener(cameraEvent, handleCameraModified)
              console.log('[DICOMViewer] Subscribed to Cornerstone3D camera modified event')
            } catch (e) {
              console.warn('[DICOMViewer] Camera modified event not available:', e)
            }
          }
        }
        
        cleanup = () => {
          if (eventTarget) {
            if (EVENTS?.VOI_MODIFIED) {
              eventTarget.removeEventListener(EVENTS.VOI_MODIFIED, handleVoiModified)
            }
            if (EVENTS?.STACK_NEW_IMAGE) {
              eventTarget.removeEventListener(EVENTS.STACK_NEW_IMAGE, handleStackNewImage)
            }
            if (EVENTS?.CAMERA_MODIFIED) {
              eventTarget.removeEventListener(EVENTS.CAMERA_MODIFIED, handleCameraModified)
            }
            console.log('[DICOMViewer] Unsubscribed from Cornerstone3D events')
          }
        }
      } catch (err) {
        console.warn('[DICOMViewer] Failed to setup event listeners:', err)
      }
    }

    setupEventListener()

    return () => {
      if (cleanup) cleanup()
    }
  }, [caseId])

  // Switch active Cornerstone3D tool when activeTool changes
  useEffect(() => {
    if (!cornerstoneInitializedRef.current) {
      return
    }

    const switchCornerstoneTool = async () => {
      try {
        const csTools = await import('@cornerstonejs/tools')
        const { 
          ToolGroupManager, ZoomTool, WindowLevelTool, PanTool, StackScrollTool,
          LengthTool, RectangleROITool, EllipticalROITool, CircleROITool,
          ArrowAnnotateTool, ProbeTool, AngleTool, TextAnnotationTool,
          Enums: ToolsEnums, addTool
        } = csTools as any
        
        // Debug: Log ALL available tools in csTools to see what's actually there
        const allToolKeys = Object.keys(csTools as any).filter(key => 
          key.includes('Tool') || key.includes('ROI') || key.includes('Annotate') || 
          key === 'Probe' || key === 'Angle' || key === 'TextAnnotation' ||
          key.includes('Elliptical') || key.includes('Circle') || key.includes('Arrow')
        )
        console.log('[DICOMViewer] All tool-related exports from @cornerstonejs/tools:', allToolKeys)
        
        // Also log the actual tool objects to see their structure
        if (EllipticalROITool) console.log('[DICOMViewer] EllipticalROITool structure:', { 
          hasToolName: !!EllipticalROITool.toolName, 
          toolName: EllipticalROITool.toolName,
          constructor: EllipticalROITool.constructor?.name 
        })
        if ((csTools as any).EllipticalROI) console.log('[DICOMViewer] EllipticalROI structure:', { 
          hasToolName: !!(csTools as any).EllipticalROI.toolName, 
          toolName: (csTools as any).EllipticalROI.toolName,
          constructor: (csTools as any).EllipticalROI.constructor?.name 
        })
        
        // Debug: Log available tools
        console.log('[DICOMViewer] Available tools:', {
          EllipticalROITool: !!EllipticalROITool,
          CircleROITool: !!CircleROITool,
          ArrowAnnotateTool: !!ArrowAnnotateTool,
          ProbeTool: !!ProbeTool,
          AngleTool: !!AngleTool,
          TextAnnotationTool: !!TextAnnotationTool,
          // Try alternative names
          EllipticalROI: !!(csTools as any).EllipticalROI,
          CircleROI: !!(csTools as any).CircleROI,
          ArrowAnnotate: !!(csTools as any).ArrowAnnotate,
          Probe: !!(csTools as any).Probe,
          Angle: !!(csTools as any).Angle,
          TextAnnotation: !!(csTools as any).TextAnnotation
        })
        
        // CRITICAL: Register annotation tools BEFORE trying to add them to tool group
        // Use the actual tool classes from the import
        const EllipticalROI = EllipticalROITool
        const CircleROI = CircleROITool
        const ArrowAnnotate = ArrowAnnotateTool
        const Probe = ProbeTool
        const Angle = AngleTool
        const TextAnnotation = TextAnnotationTool || (csTools as any).TextAnnotation
        
        // Track which tools were successfully registered (or already registered)
        const registeredTools: any[] = []
        
        if (typeof addTool === 'function') {
          // Register each tool individually with error handling
          const toolsToRegister = [
            { tool: LengthTool, name: 'LengthTool' },
            { tool: RectangleROITool, name: 'RectangleROITool' },
            { tool: EllipticalROI, name: 'EllipticalROI' },
            { tool: CircleROI, name: 'CircleROI' },
            { tool: ArrowAnnotate, name: 'ArrowAnnotate' },
            { tool: Probe, name: 'Probe' },
            { tool: Angle, name: 'Angle' },
            // TextAnnotation intentionally not registered
          ]
          
          toolsToRegister.forEach(({ tool, name }) => {
            if (tool) {
              // Verify it's a valid tool class (should have toolName property)
              if (!tool.toolName && typeof tool !== 'function') {
                console.warn(`[DICOMViewer] ⚠️ ${name} doesn't appear to be a valid tool class (no toolName property)`)
                return
              }
              
              try {
                addTool(tool)
                registeredTools.push({ tool, name })
                console.log(`[DICOMViewer] ✅ Registered ${name} globally, toolName: ${tool.toolName || 'N/A'}`)
              } catch (e: any) {
                // "Already registered" means the tool is available and ready to use - this is SUCCESS
                if (e?.message?.includes('already registered') || 
                    e?.message?.includes('already exists') || 
                    e?.message?.includes('already been added')) {
                  registeredTools.push({ tool, name })
                  console.log(`[DICOMViewer] ✅ ${name} already registered globally (ready to use), toolName: ${tool.toolName}`)
                } else {
                  console.error(`[DICOMViewer] ❌ Failed to register ${name}:`, e?.message || e)
                  // Log the tool structure for debugging
                  console.log(`[DICOMViewer] Tool structure:`, {
                    hasToolName: !!tool.toolName,
                    toolName: tool.toolName,
                    isFunction: typeof tool === 'function',
                    keys: Object.keys(tool || {}).slice(0, 10)
                  })
                }
              }
            } else {
              console.warn(`[DICOMViewer] ⚠️ ${name} tool not found in csTools`)
            }
          })
        }
        
        const toolGroup = ToolGroupManager.getToolGroup('dicom-viewer-tool-group')
        if (!toolGroup) {
          console.warn('[DICOMViewer] Tool group not found, cannot switch tool')
          return
        }
        
        // Verify viewport is in tool group (critical for annotation tools)
        const viewportId = 'dicom-viewer-viewport'
        const renderingEngineId = 'dicom-viewer-rendering-engine'
        try {
          toolGroup.addViewport(viewportId, renderingEngineId)
          console.log('[DICOMViewer] Verified viewport is in tool group')
        } catch (e) {
          // Viewport already added, that's fine
          console.log('[DICOMViewer] Viewport already in tool group')
        }

        const MouseBindings = ToolsEnums?.MouseBindings || {}
        const primary = MouseBindings.Primary ?? 1
        
        // CRITICAL: Only add tools to tool group that were successfully registered
        // Use the registered tools list - these tools are already registered globally
        // Try both tool class and tool name
        registeredTools.forEach(({ tool, name }) => {
          if (tool && tool.toolName) {
            // Try adding by tool class first (some versions prefer this)
            try {
              toolGroup.addTool(tool)
              console.log(`[DICOMViewer] ✅ ${name} added to tool group (by class), toolName: ${tool.toolName}`)
            } catch (e1: any) {
              // If that fails, try by tool name
              try {
                toolGroup.addTool(tool.toolName)
                console.log(`[DICOMViewer] ✅ ${name} added to tool group (by name), toolName: ${tool.toolName}`)
              } catch (e2: any) {
                // Check if it's just "already added" error - that's fine, tool is ready
                if (e2?.message?.includes('already registered') || 
                    e2?.message?.includes('already added') ||
                    e2?.message?.includes('already exists')) {
                  console.log(`[DICOMViewer] ✅ ${name} already in tool group (ready to use)`)
                } else if (e2?.message?.includes('not registered')) {
                  // Tool not registered - try registering it again synchronously
                  console.warn(`[DICOMViewer] ⚠️ ${name} not registered, attempting to register now...`)
                  try {
                    addTool(tool)
                    // Try adding again immediately after registration
                    try {
                      toolGroup.addTool(tool.toolName)
                      console.log(`[DICOMViewer] ✅ ${name} registered and added to tool group`)
                    } catch (e3) {
                      console.error(`[DICOMViewer] ❌ Failed to add ${name} even after registration:`, e3)
                    }
                  } catch (e3) {
                    console.error(`[DICOMViewer] ❌ Failed to register ${name}:`, e3)
                  }
                } else {
                  console.warn(`[DICOMViewer] ⚠️ ${name} failed to add to tool group:`, e2)
                }
              }
            }
          }
        })
        
        // Now set all tools to passive (after ensuring they're in the group)
        toolGroup.setToolPassive(ZoomTool.toolName)
        toolGroup.setToolPassive(WindowLevelTool.toolName)
        toolGroup.setToolPassive(PanTool.toolName)
        if (StackScrollTool) {
          try { toolGroup.setToolPassive(StackScrollTool.toolName) } catch {}
        }
        // Set annotation tools to passive (now safe since they're in the group)
        registeredTools.forEach(({ tool }) => {
          if (tool) {
            try { toolGroup.setToolPassive(tool.toolName) } catch {}
          }
        })

        // Then activate the selected tool with primary mouse button
        switch (activeTool) {
        case 'windowLevel':
            toolGroup.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: primary }] })
            console.log('[DICOMViewer] Activated WindowLevelTool')
            break
          case 'zoom':
            // Configure ZoomTool with proper settings for StackViewport
            toolGroup.setToolConfiguration(ZoomTool.toolName, {
              minZoom: 0.1,
              maxZoom: 10,
              preventZoomOutsideImage: false,
            })
            // Activate ZoomTool with primary mouse button
            toolGroup.setToolActive(ZoomTool.toolName, { 
              bindings: [{ mouseButton: primary }] 
            })
            console.log('[DICOMViewer] Activated ZoomTool with configuration')
            break
          case 'pan':
            toolGroup.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: primary }] })
            console.log('[DICOMViewer] Activated PanTool')
            break
          case 'scroll':
            // Activate StackScrollTool for drag-based scrolling
            if (StackScrollTool) {
              toolGroup.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: primary }] })
              console.log('[DICOMViewer] Activated StackScrollTool')
            }
            break
          case 'measure':
            // Activate Cornerstone3D LengthTool for measurements
            if (LengthTool) {
              // Tool should already be in group from above, but ensure it's there
              try {
                toolGroup.addTool(LengthTool.toolName)
              } catch (e) {
                // Tool already added, that's fine
              }
              
              // Configure LengthTool if needed
              try {
                toolGroup.setToolConfiguration(LengthTool.toolName, {
                  getTextCallback: (data: any) => {
                    // Custom text callback for measurements
                    if (data && data.handles) {
                      const { start, end } = data.handles
                      if (start && end) {
                        const dx = end.x - start.x
                        const dy = end.y - start.y
                        const distance = Math.sqrt(dx * dx + dy * dy)
                        // Convert pixels to mm if metadata available
                        if (metadata?.pixel_spacing) {
                          const spacing = metadata.pixel_spacing[0] || 1
                          const distanceMm = distance * spacing
                          return `${distanceMm.toFixed(2)} mm`
                        }
                        return `${distance.toFixed(2)} px`
                      }
                    }
                    return ''
                  }
                })
              } catch (e) {
                console.warn('[DICOMViewer] Failed to configure LengthTool:', e)
              }
              
              toolGroup.setToolActive(LengthTool.toolName, { bindings: [{ mouseButton: primary }] })
              console.log('[DICOMViewer] ✅ Activated LengthTool (Cornerstone3D) with mouse button', primary)
            } else {
              console.error('[DICOMViewer] ❌ LengthTool not available')
            }
            break
          case 'roi':
            // Activate Cornerstone3D RectangleROITool
            if (RectangleROITool) {
              // Tool should already be in group from above, but ensure it's there
              try {
                toolGroup.addTool(RectangleROITool.toolName)
              } catch (e) {
                // Tool already added, that's fine
              }
              
              // Configure RectangleROITool if needed
              try {
                toolGroup.setToolConfiguration(RectangleROITool.toolName, {
                  getTextCallback: (data: any) => {
                    // Custom text callback for ROI area
                    if (data && data.handles) {
                      const { points } = data.handles
                      if (points && points.length >= 2) {
                        const width = Math.abs(points[1].x - points[0].x)
                        const height = Math.abs(points[1].y - points[0].y)
                        // Convert pixels to mm if metadata available
                        if (metadata?.pixel_spacing) {
                          const spacing = metadata.pixel_spacing[0] || 1
                          const areaMm2 = (width * spacing) * (height * spacing)
                          return `${areaMm2.toFixed(2)} mm²`
                        }
                        const areaPx2 = width * height
                        return `${areaPx2.toFixed(0)} px²`
                      }
                    }
                    return ''
                  }
                })
              } catch (e) {
                console.warn('[DICOMViewer] Failed to configure RectangleROITool:', e)
              }
              
              toolGroup.setToolActive(RectangleROITool.toolName, { bindings: [{ mouseButton: primary }] })
              console.log('[DICOMViewer] ✅ Activated RectangleROITool (Cornerstone3D) with mouse button', primary)
            } else {
              console.error('[DICOMViewer] ❌ RectangleROITool not available')
            }
            break
          case 'ellipticalRoi':
            if (EllipticalROI) {
              // Ensure tool is in tool group first
              try {
                toolGroup.addTool(EllipticalROI.toolName)
              } catch (e: any) {
                // Tool already added or not registered - check error
                if (!e?.message?.includes('already') && !e?.message?.includes('not registered')) {
                  console.warn('[DICOMViewer] Warning adding EllipticalROI to group:', e)
                }
              }
              try {
                toolGroup.setToolActive(EllipticalROI.toolName, { bindings: [{ mouseButton: primary }] })
                console.log('[DICOMViewer] ✅ Activated EllipticalROI with mouse button', primary)
              } catch (e) {
                console.error('[DICOMViewer] ❌ Failed to activate EllipticalROI:', e)
              }
            } else {
              console.error('[DICOMViewer] ❌ EllipticalROI tool not available')
            }
            break
          case 'circleRoi':
            if (CircleROI) {
              // Ensure tool is in tool group first
              try {
                toolGroup.addTool(CircleROI.toolName)
              } catch (e: any) {
                if (!e?.message?.includes('already') && !e?.message?.includes('not registered')) {
                  console.warn('[DICOMViewer] Warning adding CircleROI to group:', e)
                }
              }
              try {
                toolGroup.setToolActive(CircleROI.toolName, { bindings: [{ mouseButton: primary }] })
                console.log('[DICOMViewer] ✅ Activated CircleROI with mouse button', primary)
              } catch (e) {
                console.error('[DICOMViewer] ❌ Failed to activate CircleROI:', e)
              }
            } else {
              console.error('[DICOMViewer] ❌ CircleROI tool not available')
            }
            break
          case 'arrowAnnotate':
            if (ArrowAnnotate) {
              // Ensure tool is in tool group first
              try {
                toolGroup.addTool(ArrowAnnotate.toolName)
              } catch (e: any) {
                if (!e?.message?.includes('already') && !e?.message?.includes('not registered')) {
                  console.warn('[DICOMViewer] Warning adding ArrowAnnotate to group:', e)
                }
              }
              try {
                toolGroup.setToolActive(ArrowAnnotate.toolName, { bindings: [{ mouseButton: primary }] })
                console.log('[DICOMViewer] ✅ Activated ArrowAnnotate with mouse button', primary)
              } catch (e) {
                console.error('[DICOMViewer] ❌ Failed to activate ArrowAnnotate:', e)
              }
            } else {
              console.error('[DICOMViewer] ❌ ArrowAnnotate tool not available')
            }
            break
          case 'probe':
            if (Probe) {
              // Ensure tool is in tool group first
              try {
                toolGroup.addTool(Probe.toolName)
              } catch (e: any) {
                if (!e?.message?.includes('already') && !e?.message?.includes('not registered')) {
                  console.warn('[DICOMViewer] Warning adding Probe to group:', e)
                }
              }
              try {
                toolGroup.setToolActive(Probe.toolName, { bindings: [{ mouseButton: primary }] })
                console.log('[DICOMViewer] ✅ Activated Probe with mouse button', primary)
              } catch (e) {
                console.error('[DICOMViewer] ❌ Failed to activate Probe:', e)
              }
            } else {
              console.error('[DICOMViewer] ❌ Probe tool not available')
            }
            break
        case 'angle':
            if (Angle) {
              // Ensure tool is in tool group first
              try {
                toolGroup.addTool(Angle.toolName)
              } catch (e: any) {
                if (!e?.message?.includes('already') && !e?.message?.includes('not registered')) {
                  console.warn('[DICOMViewer] Warning adding Angle to group:', e)
                }
              }
              try {
                toolGroup.setToolActive(Angle.toolName, { bindings: [{ mouseButton: primary }] })
                console.log('[DICOMViewer] ✅ Activated Angle with mouse button', primary)
              } catch (e) {
                console.error('[DICOMViewer] ❌ Failed to activate Angle:', e)
              }
            } else {
              console.error('[DICOMViewer] ❌ Angle tool not available')
            }
            break
        default:
            // For other tools (custom annotations), keep Cornerstone tools passive
            // The custom mouse handlers will handle these
            console.log('[DICOMViewer] Custom tool active:', activeTool)
            break
        }
        
        // Force viewport render to ensure tool activation is visible
        if (renderingEngineRef.current) {
          const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
          if (viewport) {
            viewport.render()
          }
        }
      } catch (err) {
        console.warn('[DICOMViewer] Failed to switch Cornerstone tool:', err)
      }
    }

    switchCornerstoneTool()
  }, [activeTool])

  // Initialize Cornerstone when viewport element is ready
  useEffect(() => {
    if (!isActive) return
    if (cornerstoneViewportRef.current && document.contains(cornerstoneViewportRef.current) && 
        !cornerstoneInitializedRef.current && frontendFiles && frontendFiles.length > 0) {
      
      const checkAndInitialize = () => {
        const viewportElement = cornerstoneViewportRef.current
        if (!viewportElement) return
        
        const rect = viewportElement.getBoundingClientRect()
        // Require minimum size before initializing
        if (rect.width >= 100 && rect.height >= 100) {
          console.log('[DICOMViewer] Viewport element ready:', rect.width, 'x', rect.height)
      initializeCornerstoneViewport().catch(err => {
        console.error('[DICOMViewer] Failed to initialize Cornerstone viewport:', err)
      })
        } else {
          console.log('[DICOMViewer] Viewport too small, waiting...', rect.width, 'x', rect.height)
          // Retry after a short delay
          setTimeout(checkAndInitialize, 200)
        }
      }
      
      // Use requestAnimationFrame to wait for initial layout
      const rafId = requestAnimationFrame(checkAndInitialize)
      return () => cancelAnimationFrame(rafId)
    }
  }, [isActive, frontendFiles, initializeCornerstoneViewport])

  // Load metadata from frontend context
  useEffect(() => {
    if (frontendMetadata) {
      console.log('[DICOMViewer] Setting metadata from frontend context')
          setMetadata({
            modality: frontendMetadata.modality,
            rows: frontendMetadata.rows,
            cols: frontendMetadata.cols,
            num_slices: frontendMetadata.numSlices,
            pixel_spacing: frontendMetadata.pixelSpacing,
            slice_thickness: frontendMetadata.sliceThickness,
            z_spacing: frontendMetadata.zSpacing,
            z_positions: frontendMetadata.zPositions,
            window: frontendMetadata.window,
            rescale: frontendMetadata.rescale,
            uids: {
              patient_id: frontendMetadata.uids.patientId,
              study_uid: frontendMetadata.uids.studyUid,
              series_uid: frontendMetadata.uids.seriesUid
            }
          })
          if (frontendMetadata.window) {
            setWindowWidth(frontendMetadata.window.width)
            setWindowCenter(frontendMetadata.window.center)
          }
    }
  }, [frontendMetadata])

  // Load DICOM data:
  // - Option 1: local upload (frontendFiles)
  // - Option 2: backend streaming (caseId)
  useEffect(() => {
    // Don't do anything if tab is not active - preserve state
    if (!isActive) return
    
    const hasLocalFiles = !!frontendFiles && frontendFiles.length > 0
    const hasCase = !!caseId

    const stackKey = hasLocalFiles ? `local:${frontendFiles.length}` : `backend:${caseId}`
    const alreadyLoaded =
      loadedStackKeyRef.current === stackKey &&
      cornerstoneImageIdsRef.current.length > 0 &&
      totalSlices > 0

    // ✅ IMPORTANT: Do not reload the stack just because the tab became active again.
    // This preserves slice index, zoom, pan, and all viewer state when switching tabs.
    // The tab-switch refresh useEffect will handle the ONE-TIME stack re-set.
    if (alreadyLoaded) {
      console.log('[DICOMViewer] Data already loaded, preserving state (no reload). Current slice:', currentSliceRef.current, 'slice state:', currentSlice)
      // Don't call setStack here - let the tab-switch useEffect handle it ONCE
      return
    }

    // Local files path
    if (hasLocalFiles) {
      if (volume && frontendMetadata && !filesLoading) {
        console.log('[DICOMViewer] Local DICOM files available, loading into viewer...')
        loadDicomData().then(() => {
          loadedStackKeyRef.current = stackKey
        })
      }
      return
    }

    // Backend streaming path
    if (hasCase && !filesLoading) {
      console.log('[DICOMViewer] Case selected, loading backend DICOM stack...')
      loadDicomData().then(() => {
        loadedStackKeyRef.current = stackKey
      })
    }
  }, [isActive, caseId, frontendFiles?.length, volume, frontendMetadata, filesLoading, loadDicomData, totalSlices, reconRefreshToken])
  
  // Reload when reconstruction is applied
  useEffect(() => {
    if (reconRefreshToken && caseId && isActive) {
      const savedSlice = currentSliceRef.current
      console.log('[DICOMViewer] Reconstruction applied, reloading DICOM data... (preserving slice:', savedSlice, ')')
      loadedStackKeyRef.current = null // Force reload
      loadDicomData().then(() => {
        const stackKey = `backend:${caseId}`
        loadedStackKeyRef.current = stackKey
        
        // Restore slice position (it may have been reset by loadDicomData)
        // Use a small delay to ensure the viewport is ready
        setTimeout(() => {
          if (savedSlice > 0 && savedSlice < cornerstoneImageIdsRef.current.length) {
            console.log('[DICOMViewer] Restoring slice position after reconstruction to:', savedSlice)
            setCurrentSlice(savedSlice)
            const viewport = renderingEngineRef.current?.getViewport('dicom-viewer-viewport') as any
            if (viewport && viewport.setImageIdIndex) {
              viewport.setImageIdIndex(savedSlice)
              viewport.render()
            }
          }
        }, 100)
      })
    }
  }, [reconRefreshToken, caseId, isActive, loadDicomData])

  // Reset the refresh flag when tab becomes inactive
  useEffect(() => {
    if (!isActive) {
      hasRefreshedAfterTabSwitchRef.current = false
    }
  }, [isActive])
  
  // When the viewer becomes active again after being hidden, force ONE resize+render
  // But only if data is already loaded (don't trigger loading state)
  useEffect(() => {
    if (!isActive) return
    
    // Only refresh if data is already loaded (preserve state, just refresh display)
    const hasData = totalSlices > 0 && cornerstoneImageIdsRef.current.length > 0
    if (!hasData) return
    
    // CRITICAL: Only do this ONCE per tab switch
    if (hasRefreshedAfterTabSwitchRef.current) {
      return
    }
    
    // Mark as refreshed immediately to prevent duplicate calls
    hasRefreshedAfterTabSwitchRef.current = true
    
    // Wait a bit longer when switching from MPR to ensure MPR viewport is fully cleaned up
    const t = setTimeout(async () => {
      try {
        const renderingEngine = renderingEngineRef.current
        if (!renderingEngine) return
        
        // Check if viewport element is visible and has dimensions
        const viewportElement = document.getElementById('dicom-viewer-viewport')
        if (viewportElement) {
          const rect = viewportElement.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) {
            console.warn('[DICOMViewer] Viewport element has zero dimensions, skipping render')
            return
          }
        }
        
        const viewport = renderingEngine?.getViewport?.('dicom-viewer-viewport') as any
        if (!viewport) return
        
        // CRITICAL: Clear Cornerstone cache to remove any corrupted images from MPR
        console.log('[DICOMViewer] Clearing Cornerstone cache after MPR...')
        try {
          const csCore = await import('@cornerstonejs/core')
          const { cache } = csCore as any
          
          // First, purge ALL volumes (MPR creates volumes that can corrupt image cache)
          if (cache && typeof cache.purgeCache === 'function') {
            cache.purgeCache()
            console.log('[DICOMViewer] ✅ Cache purged')
          } else if (cache && typeof cache.purgeVolumeCache === 'function') {
            cache.purgeVolumeCache()
            console.log('[DICOMViewer] ✅ Volume cache purged')
          }
          
          // Also try to remove any volumes specifically
          if (cache && typeof cache.getVolumes === 'function') {
            const volumes = cache.getVolumes()
            for (const vol of volumes) {
              try {
                if (cache.removeVolumeLoadObject) {
                  cache.removeVolumeLoadObject(vol.volumeId)
                }
              } catch {}
            }
          }
        } catch (e) {
          console.warn('[DICOMViewer] Cache clear error (may be ok):', e)
        }
        
        // Re-load fresh DICOM data instead of using cached images
        // IMPORTANT: Preserve the current slice position
        const savedSlice = currentSliceRef.current
        console.log('[DICOMViewer] Force reloading DICOM data after MPR... (preserving slice:', savedSlice, ')')
        loadedStackKeyRef.current = null // Force reload
        await loadDicomData()
        
        // Restore the saved slice position after reloading
        if (savedSlice > 0 && savedSlice < cornerstoneImageIdsRef.current.length) {
          console.log('[DICOMViewer] Restoring slice position to:', savedSlice)
          setCurrentSlice(savedSlice)
          // Also update the viewport to show the correct slice
          setTimeout(() => {
            const viewport = renderingEngineRef.current?.getViewport('dicom-viewer-viewport') as any
            if (viewport && viewport.setImageIdIndex) {
              viewport.setImageIdIndex(savedSlice)
              viewport.render()
            }
          }, 100)
        }
        
        console.log('[DICOMViewer] ✅ DICOM data reloaded after MPR switch')
      } catch (e) {
        console.warn('[DICOMViewer] Failed to refresh viewport on active:', e)
      }
    }, 300) // Longer delay to ensure MPR cleanup is complete
    return () => clearTimeout(t)
  }, [isActive, totalSlices, loadDicomData]) // Only depend on isActive and totalSlices for triggering
  

  // Update viewport when slice changes - USE ONLY CORNERSTONE3D (no custom canvas)
  const updateCornerstoneSlice = useCallback((sliceIndex: number) => {
    if (cornerstoneImageIdsRef.current.length === 0) {
      return
    }

    if (sliceIndex < 0 || sliceIndex >= cornerstoneImageIdsRef.current.length) {
      return
    }

    // Use ONLY Cornerstone3D for rendering - removes flicker from dual rendering
    if (renderingEngineRef.current) {
    const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
      if (viewport) {
        // Save current camera before slice change to preserve zoom/pan
        const currentCamera = viewport.getCamera ? viewport.getCamera() : null
        
        // Change slice
    viewport.setImageIdIndex(sliceIndex)
        
        // Restore camera (zoom/pan) after slice change to prevent reset
        if (currentCamera && viewport.setCamera) {
          viewport.setCamera(currentCamera)
        }
        
    viewport.render()
      }
    }
  }, [])

  // Update Cornerstone window/level when it changes
  const updateCornerstoneWindowLevel = useCallback(async () => {
    if (!renderingEngineRef.current) {
      return
    }

    try {
      const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
      if (viewport) {
        const imageIds = cornerstoneImageIdsRef.current
        const currentImageId = imageIds?.[currentSlice] || imageIds?.[0] || ''

        // Cornerstone VOI expects values in the same space as the pixel data.
        // - dicomlocal: pixels are already HU (our custom loader)
        // - wadouri: pixels are typically stored values; rescale slope/intercept convert to HU
        const slope = metadata?.rescale?.slope ?? 1
        const intercept = metadata?.rescale?.intercept ?? 0
        const isWadouri = typeof currentImageId === 'string' && currentImageId.startsWith('wadouri:')
        const safeSlope = slope === 0 ? 1 : slope

        const wcStored = isWadouri ? (windowCenter - intercept) / safeSlope : windowCenter
        const wwStored = isWadouri ? windowWidth / Math.abs(safeSlope) : windowWidth
        const lower = wcStored - wwStored / 2
        const upper = wcStored + wwStored / 2

        viewport.setProperties({
          voiRange: { lower, upper }
        })
        console.log(`[DICOMViewer] Set VOI via voiRange: lower=${lower}, upper=${upper} (isWadouri=${isWadouri})`)

        if (typeof viewport.setVOI === 'function') {
          viewport.setVOI({ lower, upper })
          console.log(`[DICOMViewer] Also set VOI via setVOI (voiRange): lower=${lower}, upper=${upper} (isWadouri=${isWadouri})`)
        }

        // Apply invert using CSS filter on canvas (Cornerstone3D doesn't have built-in invert)
        const canvas = viewport.element?.querySelector('canvas')
        if (canvas) {
          canvas.style.filter = isInverted ? 'invert(1)' : 'none'
        }

        viewport.render()
        console.log(`[DICOMViewer] Cornerstone window/level updated: WW=${windowWidth}, WC=${windowCenter}, Invert=${isInverted} (isWadouri=${isWadouri})`)
      }
    } catch (err) {
      console.error(`[DICOMViewer] Failed to update Cornerstone window/level:`, err)
    }
  }, [windowWidth, windowCenter, metadata, currentSlice, isInverted])

  // Update Cornerstone zoom when it changes
  const updateCornerstoneZoom = useCallback(async () => {
    if (!renderingEngineRef.current) {
      return
    }

    // Skip manual zoom update if ZoomTool is active (let Cornerstone handle it)
    if (activeTool === 'zoom') {
      console.log('[DICOMViewer] Skipping manual zoom update - ZoomTool is active')
      return
    }

    try {
      const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
      if (viewport && viewport.setCamera) {
        // Get current camera
        const camera = viewport.getCamera()
        if (camera) {
          // Get viewport element dimensions
          const viewportElement = cornerstoneViewportRef.current
          if (viewportElement) {
            const rect = viewportElement.getBoundingClientRect()
            const viewportWidth = rect.width
            const viewportHeight = rect.height
            
            if (viewportWidth > 0 && viewportHeight > 0) {
              // Base parallelScale (for zoom = 1) - treat this as "fit" baseline when available
              const fallbackBase = Math.max(viewportWidth, viewportHeight) / 2
              const baseParallelScale =
                baseParallelScaleRef.current ??
                (viewport.getCamera?.()?.parallelScale ?? fallbackBase)
              baseParallelScaleRef.current = baseParallelScale
              
              // Apply zoom: zoom > 1 means smaller parallelScale (more zoomed in)
              const newParallelScale = baseParallelScale / zoom
              
              viewport.setCamera({
                ...camera,
                parallelScale: newParallelScale
              })
              viewport.render()
              console.log(`[DICOMViewer] Cornerstone zoom updated: ${(zoom * 100).toFixed(0)}% (parallelScale: ${newParallelScale.toFixed(2)})`)
            }
          }
        }
      }
    } catch (err) {
      console.error(`[DICOMViewer] Failed to update Cornerstone zoom:`, err)
    }
  }, [zoom, activeTool])

  // Update slice in Cornerstone when currentSlice changes
  useEffect(() => {
    if (cornerstoneInitializedRef.current) {
      updateCornerstoneSlice(currentSlice)
    }
  }, [currentSlice, updateCornerstoneSlice])

  // Update window/level when it changes - USE ONLY CORNERSTONE3D
  useEffect(() => {
    if (cornerstoneInitializedRef.current) {
      const timeoutId = setTimeout(() => {
        // Use only Cornerstone's native rendering (no custom canvas)
        updateCornerstoneWindowLevel()
      }, 50) // Debounce window/level changes
      
      return () => clearTimeout(timeoutId)
    }
  }, [windowWidth, windowCenter, isInverted, updateCornerstoneWindowLevel])

  // Update zoom when it changes (but skip if change came from Cornerstone event)
  useEffect(() => {
    if (cornerstoneInitializedRef.current && !zoomUpdateRef.current) {
      const timeoutId = setTimeout(() => {
        updateCornerstoneZoom()
      }, 50) // Debounce zoom changes
      
      return () => clearTimeout(timeoutId)
    }
    // Reset flag after update
    if (zoomUpdateRef.current) {
      zoomUpdateRef.current = false
    }
  }, [zoom, updateCornerstoneZoom])

  // Handle slice navigation - update ref synchronously so wheel handler always sees latest slice
  const handleSliceChange = useCallback((newSlice: number) => {
    const maxSlices = totalSlices

    if (maxSlices <= 0) {
      console.warn('[DICOMViewer] Cannot change slice: no slices available', { totalSlices })
      return
    }

    const minSlice = 0
    const maxSlice = maxSlices - 1

    const clampedSlice = Math.max(minSlice, Math.min(newSlice, maxSlice))

    const prevSlice = currentSliceRef.current
    if (prevSlice !== clampedSlice) {
      console.log(`[DICOMViewer] Changing slice: ${prevSlice} -> ${clampedSlice} (range: ${minSlice}-${maxSlice})`)
      currentSliceRef.current = clampedSlice
      setCurrentSlice(clampedSlice)
    }
  }, [totalSlices])

  // Get pixel coordinates from mouse position (Cornerstone3D only)
  const getPixelCoordinates = useCallback(async (e: React.MouseEvent): Promise<{ x: number; y: number; pixelX: number; pixelY: number } | null> => {
    if (!metadata) return null
    
    // Use Cornerstone API
    if (renderingEngineRef.current) {
      try {
        const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
        if (viewport) {
          // Get canvas element from Cornerstone viewport
          const canvas = cornerstoneViewportRef.current?.querySelector('canvas')
          if (!canvas) return null
          
          const canvasRect = canvas.getBoundingClientRect()
          const canvasX = e.clientX - canvasRect.left
          const canvasY = e.clientY - canvasRect.top
          
          // Use Cornerstone's canvasToWorld to get world coordinates
          const worldPoint = viewport.canvasToWorld([canvasX, canvasY])
          
          // Get image data to properly convert world → pixel coordinates
          // For StackViewport, we need to account for spacing and origin
          const imageData = viewport.getImageData()
          
          let pixelX: number
          let pixelY: number
          
          if (imageData && imageData.origin && imageData.spacing) {
            // Proper world-to-index conversion using image origin and spacing
            pixelX = Math.round((worldPoint[0] - imageData.origin[0]) / imageData.spacing[0])
            pixelY = Math.round((worldPoint[1] - imageData.origin[1]) / imageData.spacing[1])
          } else {
            // Fallback: try using worldToIndex if available
            if (typeof viewport.worldToIndex === 'function') {
              const indexPoint = viewport.worldToIndex(worldPoint)
              pixelX = Math.round(indexPoint[0])
              pixelY = Math.round(indexPoint[1])
            } else {
              // Last resort: use world coordinates directly (may not be accurate)
              pixelX = Math.round(worldPoint[0])
              pixelY = Math.round(worldPoint[1])
            }
          }
          
          // Validate bounds
          if (pixelX >= 0 && pixelX < metadata.cols && pixelY >= 0 && pixelY < metadata.rows) {
            return { x: e.clientX, y: e.clientY, pixelX, pixelY }
          }
        }
      } catch (err) {
        console.error('Error getting Cornerstone pixel coordinates:', err)
      }
      return null
    }
    
      return null
  }, [metadata])

  // Calculate distance between two points in mm
  const calculateDistance = useCallback((p1: { x: number; y: number }, p2: { x: number; y: number }): number => {
    if (!metadata) return 0
    const dx = (p2.x - p1.x) * metadata.pixel_spacing[1] // col spacing
    const dy = (p2.y - p1.y) * metadata.pixel_spacing[0] // row spacing
    return Math.sqrt(dx * dx + dy * dy)
  }, [metadata])

  // Mouse down handler
  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return // Only left click
    
    const pixelCoords = await getPixelCoordinates(e)
    if (!pixelCoords) return
    
    // Handle annotation tools
    if (activeTool === 'arrow' || activeTool === 'line' || activeTool === 'circle' || activeTool === 'rectangle') {
      console.log('Starting annotation:', activeTool, pixelCoords)
      const newAnnotation: Annotation = {
        id: `ann-${Date.now()}`,
        type: activeTool,
        points: [{ x: pixelCoords.pixelX, y: pixelCoords.pixelY }],
        color: annotationColor,
        strokeWidth: 2,
        createdAt: Date.now(),
        sliceIndex: currentSlice
      }
      setActiveAnnotation(newAnnotation)
      setIsDragging(true) // Enable dragging for annotation tools
      setDragStart({ x: e.clientX, y: e.clientY })
      return
    }
    
    // Text annotation tool removed
    
    if (activeTool === 'freehand') {
      const newAnnotation: Annotation = {
        id: `ann-${Date.now()}`,
        type: 'freehand',
        points: [{ x: pixelCoords.pixelX, y: pixelCoords.pixelY }],
        color: annotationColor,
        strokeWidth: 2,
        fill: true,
        fillOpacity: 0.2,
        createdAt: Date.now(),
        sliceIndex: currentSlice
      }
      setActiveAnnotation(newAnnotation)
      setIsDragging(true) // Enable dragging for freehand
      return
    }
    
    // Let Cornerstone3D handle measurement and ROI tools natively
    // The annotation tools are activated in the tool group
    if (activeTool === 'measure' || activeTool === 'roi' || activeTool === 'ellipticalRoi' || 
        activeTool === 'circleRoi' || activeTool === 'arrowAnnotate' || activeTool === 'probe' || 
        activeTool === 'angle') {
      // Cornerstone3D annotation tools handle these - don't intercept clicks
      console.log('[DICOMViewer] Letting Cornerstone3D handle annotation tool:', activeTool)
      return
    }
    
    // Let Cornerstone3D handle windowLevel, zoom, and pan tools
    // Our custom handlers only process scroll and other custom tools
    if (activeTool === 'windowLevel' || activeTool === 'zoom' || activeTool === 'pan') {
      // Cornerstone3D tools handle these - just track for scroll tool fallback
      setIsDragging(true)
      setDragStart({ x: e.clientX, y: e.clientY })
      return
    }
    
    // For scroll and other tools, use our custom handling
    setIsDragging(true)
    setDragStart({ x: e.clientX, y: e.clientY })
    setDragStartValues({ ww: windowWidth, wc: windowCenter, panX, panY, zoom })
  }, [windowWidth, windowCenter, panX, panY, zoom, activeTool, getPixelCoordinates, currentMeasurement, measurements, calculateDistance, annotationColor, currentSlice, annotations])

  // Calculate HU value from Cornerstone image data (no backend needed)
  const calculateHUValue = useCallback(async (pixelX: number, pixelY: number) => {
    if (!metadata || !renderingEngineRef.current) {
      setHUValue(null)
      return
    }

    // Validate pixel coordinates are within image bounds
    if (pixelX < 0 || pixelX >= metadata.cols || pixelY < 0 || pixelY >= metadata.rows) {
      setHUValue(null)
      return
    }

    try {
      // Get the current imageId from the viewport
      const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
      if (!viewport) {
        setHUValue(null)
        return
      }

      // Get the current imageId from the stack
      const imageIds = cornerstoneImageIdsRef.current
      if (currentSlice < 0 || currentSlice >= imageIds.length) {
        setHUValue(null)
        return
      }

      const imageId = imageIds[currentSlice]
      
      // Get the image from Cornerstone cache
      const csCore = await import('@cornerstonejs/core')
      const cachedImage = csCore.cache.getImage(imageId)
      
      if (!cachedImage) {
        setHUValue(null)
        return
      }

      // Get pixel data from the cached image
      const pixelData = cachedImage.getPixelData()
      if (!pixelData) {
        setHUValue(null)
        return
      }

      const index = pixelY * metadata.cols + pixelX
      
      if (index >= 0 && index < pixelData.length) {
        const pixelValue = pixelData[index]

        // dicomlocal: pixels are already HU (custom loader converts to HU and sets slope/intercept to 1/0)
        // wadouri: pixels are stored values, convert to HU using rescale
        const isWadouri = typeof imageId === 'string' && imageId.startsWith('wadouri:')
        const rescaleSlope = metadata.rescale?.slope ?? 1
        const rescaleIntercept = metadata.rescale?.intercept ?? 0
        const huValue = isWadouri ? pixelValue * rescaleSlope + rescaleIntercept : pixelValue
        
        // Simple tissue type classification
        let tissueType = 'Unknown'
        if (huValue < -50) tissueType = 'Air'
        else if (huValue < 10) tissueType = 'Fat'
        else if (huValue < 40) tissueType = 'Water'
        else if (huValue < 80) tissueType = 'Soft Tissue'
        else if (huValue < 300) tissueType = 'Bone'
        else tissueType = 'Dense Bone'
        
          setHUValue({
          hu_value: huValue,
          tissue_type: tissueType
          })
        } else {
          setHUValue(null)
        }
    } catch (error) {
      console.error('[DICOMViewer] Failed to calculate HU value:', error)
        setHUValue(null)
      }
  }, [metadata, currentSlice])

  // Mouse move handler
  const handleMouseMove = useCallback(async (e: React.MouseEvent) => {
    try {
      // Update pixel info for hover display
      const pixelCoords = await getPixelCoordinates(e)
      if (pixelCoords) {
        setPixelInfo(pixelCoords)
        
        // Calculate HU value - validate coordinates are within bounds
        if (metadata && 
            pixelCoords.pixelX >= 0 && pixelCoords.pixelX < metadata.cols &&
            pixelCoords.pixelY >= 0 && pixelCoords.pixelY < metadata.rows) {
          // Debounce HU calculation
          if (huFetchTimeoutRef.current) {
            clearTimeout(huFetchTimeoutRef.current)
          }
          setLoadingHU(true)
          huFetchTimeoutRef.current = setTimeout(() => {
            calculateHUValue(pixelCoords.pixelX, pixelCoords.pixelY)
            setLoadingHU(false)
          }, 150)
        } else {
          // Clear HU value if outside bounds
          setHUValue(null)
        }
      } else {
        // Clear HU value if no coordinates
        setHUValue(null)
      }
      
      // Handle annotation tools during dragging
      if (isDragging && activeAnnotation) {
        const coords = await getPixelCoordinates(e)
        if (coords) {
          if (activeAnnotation.type === 'freehand') {
            // Freehand: continuously add points (throttle to avoid too many points)
            const lastPoint = activeAnnotation.points[activeAnnotation.points.length - 1]
            const distance = Math.sqrt(
              Math.pow(coords.pixelX - lastPoint.x, 2) + Math.pow(coords.pixelY - lastPoint.y, 2)
            )
            // Only add point if moved at least 2 pixels
            if (distance > 2) {
              setActiveAnnotation({
                ...activeAnnotation,
                points: [...activeAnnotation.points, { x: coords.pixelX, y: coords.pixelY }]
              })
            }
          } else if (activeAnnotation.type === 'arrow' || activeAnnotation.type === 'line' || 
                     activeAnnotation.type === 'circle' || activeAnnotation.type === 'rectangle') {
            // Other annotations: update second point
            if (activeAnnotation.points.length === 1) {
              setActiveAnnotation({
                ...activeAnnotation,
                points: [...activeAnnotation.points, { x: coords.pixelX, y: coords.pixelY }]
              })
            } else {
              setActiveAnnotation({
                ...activeAnnotation,
                points: [activeAnnotation.points[0], { x: coords.pixelX, y: coords.pixelY }]
              })
            }
          }
        }
        return // Don't process other tools when drawing annotation
      }
      
      if (!isDragging) {
        // Cornerstone3D annotation tools (measure, roi) handle their own interactions
        // No custom preview needed
        return
      }
      
      // Cornerstone3D handles windowLevel, zoom, pan, measure, roi - skip custom handling
      if (activeTool === 'windowLevel' || activeTool === 'zoom' || activeTool === 'pan' ||
          activeTool === 'measure' || activeTool === 'roi' || activeTool === 'ellipticalRoi' || 
          activeTool === 'circleRoi' || activeTool === 'arrowAnnotate' || activeTool === 'probe' || 
          activeTool === 'angle') {
        // Cornerstone3D tools handle these interactions
        return
      }
      
      // Handle dragging for custom tools (scroll, etc.)
      const deltaX = e.clientX - dragStart.x
      const deltaY = e.clientY - dragStart.y
      
      switch (activeTool) {
        case 'scroll':
          // Vertical drag = scroll through slices (use ref for responsive updates)
          const sliceDelta = Math.round(deltaY / 10)
          handleSliceChange(currentSliceRef.current + sliceDelta)
          break
      }
    } catch (error) {
      console.error('Error in handleMouseMove:', error)
    }
  }, [isDragging, dragStart, dragStartValues, activeTool, handleSliceChange, getPixelCoordinates, currentMeasurement, calculateHUValue, metadata, activeAnnotation])

  // Mouse up handler
  const handleMouseUp = useCallback(() => {
    // Complete custom annotation (arrow, line, circle, rectangle, freehand)
    // Note: measure and roi are now handled by Cornerstone3D tools
    if (activeAnnotation) {
      console.log('Completing custom annotation:', activeAnnotation.type, activeAnnotation.points.length)
      if (activeAnnotation.type === 'freehand' && activeAnnotation.points.length >= 2) {
        setAnnotations(prev => [...prev, activeAnnotation])
        setActiveAnnotation(null)
      } else if (activeAnnotation.points.length >= 2) {
        setAnnotations(prev => [...prev, activeAnnotation])
        setActiveAnnotation(null)
      } else {
        // If annotation has only 1 point, cancel it
        setActiveAnnotation(null)
      }
    }
    
    // Cornerstone3D handles measure and roi tools natively - no custom handling needed
    setIsDragging(false)
  }, [activeAnnotation])

  // Scroll wheel handler - use ref so rapid scroll sees latest slice immediately
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    e.stopPropagation() // Prevent Cornerstone from also handling this

    if (e.ctrlKey) {
      // Ctrl + wheel = zoom
      const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1
      setZoom(prev => Math.max(0.1, Math.min(10, prev * zoomDelta)))
    } else {
      // Regular wheel = scroll slices (use ref to avoid stale closure on rapid scroll)
      const delta = e.deltaY > 0 ? 1 : -1
      handleSliceChange(currentSliceRef.current + delta)
    }
  }, [handleSliceChange])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      container.removeEventListener('wheel', handleWheel)
    }
  }, [handleWheel])

  // Capture current viewport with annotations and windowing using canvas
  const captureSliceWithAnnotations = useCallback(async (): Promise<string> => {
    if (!renderingEngineRef.current || !metadata) {
      throw new Error('Cannot capture: rendering engine or metadata not available')
    }

    // Get the Cornerstone3D viewport
    const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
    if (!viewport) {
      throw new Error('Viewport not found')
    }

    // Ensure viewport is rendered before capture
    if (viewport.render) {
      viewport.render()
    }

    // Get the canvas element from the viewport
    const viewportElement = document.getElementById('dicom-viewer-viewport')
    if (!viewportElement) {
      throw new Error('Viewport element not found')
    }

    // Find the canvas element (Cornerstone3D renders on canvas)
    const canvasElement = viewportElement.querySelector('canvas') as HTMLCanvasElement
    if (!canvasElement) {
      throw new Error('Canvas element not found in viewport')
    }

    // Wait for canvas to be fully rendered with annotations
    await new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve) // Double RAF to ensure rendering is complete
      })
    })
    
    // Additional wait to ensure annotations are drawn
    await new Promise(resolve => setTimeout(resolve, 100))

    // Create a new canvas for capturing with annotations
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Cannot get canvas context')
    }

    // Use canvas natural size for high quality
    const canvasWidth = canvasElement.width || canvasElement.clientWidth
    const canvasHeight = canvasElement.height || canvasElement.clientHeight
    
    canvas.width = canvasWidth
    canvas.height = canvasHeight

    // Draw the base image from Cornerstone3D canvas
    ctx.drawImage(canvasElement, 0, 0, canvas.width, canvas.height)

    // Get annotations from both local state and Cornerstone3D tool group
    let allAnnotations = [...annotations]
    let allMeasurements = [...measurements]
    
    console.log('[DICOMViewer] Starting capture - local annotations:', annotations.length, 'for slice:', currentSlice)
    console.log('[DICOMViewer] Local annotations detail:', annotations.map(a => ({
      id: a.id, 
      type: a.type, 
      sliceIndex: a.sliceIndex, 
      pointsCount: a.points?.length,
      color: a.color
    })))
    
    try {
      const csTools = await import('@cornerstonejs/tools')
      const { annotation: annotationModule, ToolGroupManager } = csTools as any
      
      if (annotationModule && annotationModule.state && ToolGroupManager) {
        const toolGroup = ToolGroupManager.getToolGroup('dicom-viewer-tool-group')
        
        if (toolGroup) {
          // Get annotations from Cornerstone3D tool group
          const cornerstoneAnnotations = annotationModule.state.getAnnotations(viewportElement, 'dicom-viewer-tool-group') || []
          console.log('[DICOMViewer] Found Cornerstone annotations for capture:', cornerstoneAnnotations.length)
          
          // Also try getAllAnnotations as fallback
          if (cornerstoneAnnotations.length === 0) {
            const allCornerstoneAnnotations = annotationModule.state.getAllAnnotations() || []
            console.log('[DICOMViewer] Total Cornerstone annotations:', allCornerstoneAnnotations.length)
            
            // Log annotation structure for debugging
            if (allCornerstoneAnnotations.length > 0) {
              console.log('[DICOMViewer] Sample annotation structure:', JSON.stringify(allCornerstoneAnnotations[0], null, 2))
            }
            
            // Include ALL Cornerstone annotations - they're all from our viewport since we only have one
            // The annotations are associated with imageIds, not viewportIds
            const viewportAnnotations = allCornerstoneAnnotations
            console.log('[DICOMViewer] Using all Cornerstone annotations:', viewportAnnotations.length)
            
            // Convert to our format - Cornerstone annotations use WORLD coordinates
            viewportAnnotations.forEach((ann: any) => {
              try {
                console.log('[DICOMViewer] Processing Cornerstone annotation:', {
                  uid: ann.annotationUID,
                  toolName: ann.metadata?.toolName,
                  hasHandles: !!ann.data?.handles,
                  handlesKeys: ann.data?.handles ? Object.keys(ann.data.handles) : []
                })
                
                // Cornerstone3D stores points in world coordinates in data.handles.points
                // For tools like ArrowAnnotate, Length, etc., points are 3D world coordinates [x, y, z]
                let worldPoints = ann.data?.handles?.points || []
                
                // Some tools use different handle structures
                if (worldPoints.length === 0 && ann.data?.handles) {
                  // Try to extract points from other handle properties
                  const handles = ann.data.handles
                  if (handles.start && handles.end) {
                    worldPoints = [handles.start, handles.end]
                  } else if (handles.center && handles.radius) {
                    // Circle/ellipse: use center point
                    worldPoints = [handles.center]
                  }
                }
                
                if (worldPoints && worldPoints.length > 0) {
                  // Convert world coordinates to canvas coordinates using viewport
                  const canvasPoints: { x: number; y: number }[] = []
                  
                  for (const worldPoint of worldPoints) {
                    try {
                      // worldPoint is [x, y, z] in world coordinates
                      const wp = Array.isArray(worldPoint) 
                        ? worldPoint 
                        : [worldPoint.x || worldPoint[0] || 0, worldPoint.y || worldPoint[1] || 0, worldPoint.z || worldPoint[2] || 0]
                      
                      // Convert to canvas coordinates
                      const canvasCoord = viewport.worldToCanvas(wp)
                      if (canvasCoord && !isNaN(canvasCoord[0]) && !isNaN(canvasCoord[1])) {
                        canvasPoints.push({ x: canvasCoord[0], y: canvasCoord[1] })
                      }
                    } catch (convErr) {
                      console.warn('[DICOMViewer] Error converting world point:', convErr, worldPoint)
                    }
                  }
                  
                  console.log('[DICOMViewer] Converted points:', { 
                    worldPoints: worldPoints.length, 
                    canvasPoints: canvasPoints.length,
                    sample: canvasPoints[0]
                  })
                  
                  if (canvasPoints.length > 0) {
                    // Store canvas coordinates directly (not pixel coordinates)
                    // These will be drawn directly without further transformation
                    allAnnotations.push({
                      id: ann.annotationUID || ann.id,
                      type: ann.metadata?.toolName || 'line',
                      points: canvasPoints,
                      sliceIndex: currentSlice,
                      color: ann.metadata?.color || '#ffff00', // Yellow for Cornerstone annotations
                      strokeWidth: 2,
                      createdAt: Date.now(),
                      isCanvasCoords: true // Flag to indicate these are already canvas coords
                    } as any)
                  }
                }
              } catch (e) {
                console.warn('[DICOMViewer] Error converting annotation:', e, ann)
              }
            })
          } else {
            // Convert Cornerstone annotations to our format
            cornerstoneAnnotations.forEach((ann: any) => {
              try {
                if (ann.metadata && ann.metadata.viewportId === 'dicom-viewer-viewport') {
                  const points = ann.data?.handles?.points || ann.data?.handles?.pointsList || []
                  if (points && points.length > 0) {
                    allAnnotations.push({
                      id: ann.annotationUID || ann.id,
                      type: ann.metadata?.toolName || 'line',
                      points: points.map((p: any) => ({ 
                        x: Array.isArray(p) ? p[0] : (p.x || 0), 
                        y: Array.isArray(p) ? p[1] : (p.y || 0) 
                      })),
                      sliceIndex: currentSlice,
                      color: ann.metadata?.color || '#3b82f6',
                      strokeWidth: 2,
                      createdAt: Date.now()
                    } as any)
                  }
                }
              } catch (e) {
                console.warn('[DICOMViewer] Error converting annotation:', e, ann)
              }
            })
          }
        }
      }
    } catch (e) {
      console.warn('[DICOMViewer] Could not retrieve Cornerstone annotations:', e)
    }

    // Get current slice annotations and measurements
    const sliceAnnotations = allAnnotations.filter(a => a.sliceIndex === currentSlice)
    const sliceMeasurements = allMeasurements.filter(m => true) // Measurements don't have sliceIndex
    
    console.log('[DICOMViewer] Capturing with annotations:', {
      localAnnotations: annotations.length,
      totalAnnotations: allAnnotations.length,
      sliceAnnotations: sliceAnnotations.length,
      currentSlice,
      annotationTypes: sliceAnnotations.map(a => a.type),
      sliceAnnotationDetails: sliceAnnotations.map(a => ({
        id: a.id,
        type: a.type,
        points: a.points,
        color: a.color
      }))
    })
    
    if (sliceAnnotations.length === 0) {
      console.warn('[DICOMViewer] ⚠️ No annotations found for current slice:', currentSlice)
    } else {
      console.log('[DICOMViewer] ✅ Found', sliceAnnotations.length, 'annotations for slice', currentSlice)
    }

    // Use Cornerstone3D's coordinate transformation for accurate annotation positioning
    // This accounts for zoom, pan, and camera transformations
    const imageData = viewport.getImageData()
    
    // Create a function to convert pixel coordinates to canvas coordinates
    const pixelToCanvas = (pixelX: number, pixelY: number): { x: number; y: number } | null => {
      try {
        if (imageData && imageData.origin && imageData.spacing) {
          // Convert pixel index to world coordinates using image origin and spacing
          const worldPoint: [number, number, number] = [
            imageData.origin[0] + pixelX * imageData.spacing[0],
            imageData.origin[1] + pixelY * imageData.spacing[1],
            imageData.origin[2] || 0
          ]
          
          // Convert world coordinates to canvas coordinates
          const canvasPoint = viewport.worldToCanvas(worldPoint)
          return { x: canvasPoint[0], y: canvasPoint[1] }
        } else if (typeof viewport.indexToWorld === 'function') {
          // Use Cornerstone's indexToWorld if available
          const worldPoint = viewport.indexToWorld([pixelX, pixelY, currentSlice])
          const canvasPoint = viewport.worldToCanvas(worldPoint)
          return { x: canvasPoint[0], y: canvasPoint[1] }
        }
      } catch (error) {
        console.warn('[DICOMViewer] Error in pixelToCanvas:', error)
      }
      
      // Fallback: simple scale
      const scaleX = canvasWidth / (metadata.cols || 512)
      const scaleY = canvasHeight / (metadata.rows || 512)
      console.log('[DICOMViewer] Using fallback scale:', { scaleX, scaleY, canvasWidth, canvasHeight, metaCols: metadata.cols, metaRows: metadata.rows })
      return { x: pixelX * scaleX, y: pixelY * scaleY }
    }
    
    // Log image data info for debugging
    console.log('[DICOMViewer] Capture imageData:', {
      hasImageData: !!imageData,
      origin: imageData?.origin,
      spacing: imageData?.spacing,
      canvasSize: { canvasWidth, canvasHeight },
      metadataSize: { cols: metadata.cols, rows: metadata.rows }
    })
    
    // Note: pixelToCanvas function above handles coordinate conversion with fallback to simple scale

    // Draw measurements using proper coordinate transformation
    sliceMeasurements.forEach((measurement) => {
      if (measurement.points.length === 0) return
      
      const color = '#3b82f6'
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = 2

      if (measurement.type === 'distance' && measurement.points.length === 2) {
        const [p1, p2] = measurement.points
        const canvasP1 = pixelToCanvas(p1.x, p1.y)
        const canvasP2 = pixelToCanvas(p2.x, p2.y)
        
        if (!canvasP1 || !canvasP2) return
        
        const x1 = canvasP1.x
        const y1 = canvasP1.y
        const x2 = canvasP2.x
        const y2 = canvasP2.y

        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()

        ctx.beginPath()
        ctx.arc(x1, y1, 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.beginPath()
        ctx.arc(x2, y2, 4, 0, Math.PI * 2)
        ctx.fill()

        if (measurement.value !== undefined) {
          const midX = (x1 + x2) / 2
          const midY = (y1 + y2) / 2
          ctx.fillStyle = color
          ctx.font = 'bold 12px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(`${measurement.value.toFixed(2)} mm`, midX, midY - 10)
        }
      } else if (measurement.type === 'roi' && measurement.points.length >= 2) {
        ctx.beginPath()
        measurement.points.forEach((point, idx) => {
          const canvasP = pixelToCanvas(point.x, point.y)
          if (!canvasP) return
          if (idx === 0) {
            ctx.moveTo(canvasP.x, canvasP.y)
          } else {
            ctx.lineTo(canvasP.x, canvasP.y)
          }
        })
        ctx.closePath()
        ctx.stroke()
      }
    })

    // Draw annotations using proper coordinate transformation
    sliceAnnotations.forEach((annotation) => {
      try {
        if (!annotation || !annotation.points || annotation.points.length === 0) {
          console.warn('[DICOMViewer] Skipping invalid annotation:', annotation)
          return
        }
        
        const color = annotation.color || '#3b82f6'
        ctx.strokeStyle = color
        ctx.fillStyle = color
        ctx.lineWidth = annotation.strokeWidth || 2
        
        // Check if annotation is already in canvas coordinates (Cornerstone annotations)
        const isCanvasCoords = (annotation as any).isCanvasCoords === true
        
        // Get annotation type as string to handle both local and Cornerstone types
        const annType = String(annotation.type).toLowerCase()
        
        // Helper function to get canvas coordinates
        const getCanvasCoord = (point: { x: number; y: number }): { x: number; y: number } | null => {
          if (isCanvasCoords) {
            return point // Already in canvas coordinates
          }
          return pixelToCanvas(point.x, point.y) // Convert from pixel to canvas
        }

        if ((annType === 'arrow' || annType === 'arrowannotate') && annotation.points.length === 2) {
          const [p1, p2] = annotation.points
          const canvasP1 = getCanvasCoord(p1)
          const canvasP2 = getCanvasCoord(p2)
          
          if (!canvasP1 || !canvasP2) {
            console.warn('[DICOMViewer] Could not convert arrow coordinates')
            return
          }
          
          const x1 = canvasP1.x
          const y1 = canvasP1.y
          const x2 = canvasP2.x
          const y2 = canvasP2.y

          ctx.beginPath()
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
          ctx.stroke()

          const angle = Math.atan2(y2 - y1, x2 - x1)
          const arrowLength = 10
          ctx.beginPath()
          ctx.moveTo(x2, y2)
          ctx.lineTo(
            x2 - arrowLength * Math.cos(angle - Math.PI / 6),
            y2 - arrowLength * Math.sin(angle - Math.PI / 6)
          )
          ctx.lineTo(
            x2 - arrowLength * Math.cos(angle + Math.PI / 6),
            y2 - arrowLength * Math.sin(angle + Math.PI / 6)
          )
          ctx.closePath()
          ctx.fill()
          console.log('[DICOMViewer] Drew arrow annotation at:', { x1, y1, x2, y2 })
        } else if ((annType === 'line' || annType === 'length') && annotation.points.length === 2) {
          const [p1, p2] = annotation.points
          const canvasP1 = getCanvasCoord(p1)
          const canvasP2 = getCanvasCoord(p2)
          
          if (!canvasP1 || !canvasP2) {
            console.warn('[DICOMViewer] Could not convert line coordinates')
            return
          }
          
          ctx.beginPath()
          ctx.moveTo(canvasP1.x, canvasP1.y)
          ctx.lineTo(canvasP2.x, canvasP2.y)
          ctx.stroke()
          
          // Draw endpoints
          ctx.beginPath()
          ctx.arc(canvasP1.x, canvasP1.y, 3, 0, Math.PI * 2)
          ctx.fill()
          ctx.beginPath()
          ctx.arc(canvasP2.x, canvasP2.y, 3, 0, Math.PI * 2)
          ctx.fill()
          
          console.log('[DICOMViewer] Drew line/Length annotation at:', canvasP1, canvasP2)
        } else if ((annType === 'circle' || annType === 'ellipticalroi' || annType === 'circleroi') && annotation.points.length >= 1) {
          const canvasP1 = getCanvasCoord(annotation.points[0])
          
          if (!canvasP1) {
            console.warn('[DICOMViewer] Could not convert circle coordinates')
            return
          }
          
          let radius = 20 // Default radius
          if (annotation.points.length >= 2) {
            const canvasP2 = getCanvasCoord(annotation.points[1])
            if (canvasP2) {
              radius = Math.sqrt(
                Math.pow(canvasP2.x - canvasP1.x, 2) + Math.pow(canvasP2.y - canvasP1.y, 2)
              )
            }
          }
          
          ctx.beginPath()
          ctx.arc(canvasP1.x, canvasP1.y, radius, 0, Math.PI * 2)
          ctx.stroke()
          console.log('[DICOMViewer] Drew circle annotation at:', { x: canvasP1.x, y: canvasP1.y, radius })
        } else if ((annType === 'rectangle' || annType === 'rectangleroi') && annotation.points.length === 2) {
          const [p1, p2] = annotation.points
          const canvasP1 = getCanvasCoord(p1)
          const canvasP2 = getCanvasCoord(p2)
          
          if (!canvasP1 || !canvasP2) {
            console.warn('[DICOMViewer] Could not convert rectangle coordinates')
            return
          }
          
          const x = Math.min(canvasP1.x, canvasP2.x)
          const y = Math.min(canvasP1.y, canvasP2.y)
          const w = Math.abs(canvasP2.x - canvasP1.x)
          const h = Math.abs(canvasP2.y - canvasP1.y)
          ctx.strokeRect(x, y, w, h)
          console.log('[DICOMViewer] Drew rectangle annotation at:', { x, y, w, h })
        } else if ((annType === 'freehand' || annType === 'planarfreehandroi') && annotation.points.length > 0) {
          ctx.beginPath()
          let drewSomething = false
          annotation.points.forEach((point, idx) => {
            const canvasP = getCanvasCoord(point)
            if (!canvasP) return
            if (idx === 0) {
              ctx.moveTo(canvasP.x, canvasP.y)
            } else {
              ctx.lineTo(canvasP.x, canvasP.y)
            }
            drewSomething = true
          })
          if (drewSomething) {
            ctx.stroke()
            console.log('[DICOMViewer] Drew freehand annotation with', annotation.points.length, 'points')
          }
        } else if (annType === 'text' && annotation.points.length > 0 && annotation.text) {
          const canvasP = getCanvasCoord(annotation.points[0])
          if (canvasP) {
            ctx.font = `bold ${annotation.fontSize || 14}px sans-serif`
            ctx.fillStyle = annotation.color || '#3b82f6'
            ctx.textAlign = 'left'
            ctx.textBaseline = 'top'
            // Draw background
            const textMetrics = ctx.measureText(annotation.text)
            ctx.fillStyle = 'rgba(0,0,0,0.7)'
            ctx.fillRect(canvasP.x - 2, canvasP.y - 2, textMetrics.width + 4, (annotation.fontSize || 14) + 4)
            // Draw text
            ctx.fillStyle = annotation.color || '#3b82f6'
            ctx.fillText(annotation.text, canvasP.x, canvasP.y)
            console.log('[DICOMViewer] Drew text annotation:', annotation.text, 'at:', canvasP)
          }
        } else if (annType === 'probe' && annotation.points.length > 0) {
          // Probe is a single point marker
          const canvasP = getCanvasCoord(annotation.points[0])
          if (canvasP) {
            ctx.beginPath()
            ctx.arc(canvasP.x, canvasP.y, 5, 0, Math.PI * 2)
            ctx.fill()
            // Draw crosshair
            ctx.beginPath()
            ctx.moveTo(canvasP.x - 10, canvasP.y)
            ctx.lineTo(canvasP.x + 10, canvasP.y)
            ctx.moveTo(canvasP.x, canvasP.y - 10)
            ctx.lineTo(canvasP.x, canvasP.y + 10)
            ctx.stroke()
            console.log('[DICOMViewer] Drew Probe annotation at:', canvasP)
          }
        } else if (annType === 'angle' && annotation.points.length >= 3) {
          // Angle has 3 points
          const canvasPoints = annotation.points.map(p => getCanvasCoord(p)).filter(p => p !== null) as { x: number; y: number }[]
          if (canvasPoints.length >= 3) {
            ctx.beginPath()
            ctx.moveTo(canvasPoints[0].x, canvasPoints[0].y)
            ctx.lineTo(canvasPoints[1].x, canvasPoints[1].y)
            ctx.lineTo(canvasPoints[2].x, canvasPoints[2].y)
            ctx.stroke()
            // Draw points
            canvasPoints.forEach(p => {
              ctx.beginPath()
              ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
              ctx.fill()
            })
            console.log('[DICOMViewer] Drew Angle annotation')
          }
        } else {
          // Unknown annotation type, try to draw as line connecting all points
          console.warn('[DICOMViewer] Unknown annotation type:', annType, 'drawing as connected line')
          if (annotation.points && annotation.points.length >= 2) {
            const firstP = getCanvasCoord(annotation.points[0])
            if (firstP) {
              ctx.beginPath()
              ctx.moveTo(firstP.x, firstP.y)
              for (let i = 1; i < annotation.points.length; i++) {
                const canvasP = getCanvasCoord(annotation.points[i])
                if (canvasP) {
                  ctx.lineTo(canvasP.x, canvasP.y)
                }
              }
              ctx.stroke()
              // Draw endpoints
              annotation.points.forEach(p => {
                const canvasP = getCanvasCoord(p)
                if (canvasP) {
                  ctx.beginPath()
                  ctx.arc(canvasP.x, canvasP.y, 3, 0, Math.PI * 2)
                  ctx.fill()
                }
              })
            }
          } else if (annotation.points && annotation.points.length === 1) {
            // Single point - draw as marker
            const canvasP = getCanvasCoord(annotation.points[0])
            if (canvasP) {
              ctx.beginPath()
              ctx.arc(canvasP.x, canvasP.y, 5, 0, Math.PI * 2)
              ctx.fill()
            }
          }
        }
      } catch (error) {
        console.error('[DICOMViewer] Error drawing annotation:', error, annotation)
        // Continue with other annotations even if one fails
      }
    })

    console.log('[DICOMViewer] ✅ Canvas capture complete, annotations drawn:', sliceAnnotations.length)
    return canvas.toDataURL('image/png')
  }, [currentSlice, annotations, measurements, metadata, windowWidth, windowCenter])

  // Save current slice to film with annotations and windowing
  const handleSaveToFilm = useCallback(async () => {
    if (!cornerstoneInitializedRef.current || !metadata) {
      setToastMessage('No slice available to save')
      return
    }
    
    if (!renderingEngineRef.current) {
      setToastMessage('Rendering engine not initialized')
      return
    }
    
    try {
      console.log('[DICOMViewer] Capturing slice for film...', {
        currentSlice,
        hasMetadata: !!metadata,
        hasRenderingEngine: !!renderingEngineRef.current
      })
      
      // Capture the slice with annotations and windowing applied
      let capturedImage: string
      try {
        capturedImage = await captureSliceWithAnnotations()
      } catch (captureError: any) {
        console.error('[DICOMViewer] Failed to capture with annotations, trying without:', captureError)
        // Fallback: try capturing without annotations
        const viewportElement = document.getElementById('dicom-viewer-viewport')
        const canvasElement = viewportElement?.querySelector('canvas') as HTMLCanvasElement
        if (!canvasElement) {
          throw new Error('Cannot capture: canvas not found')
        }
        
        // Wait for render
        await new Promise(resolve => {
          requestAnimationFrame(() => {
            requestAnimationFrame(resolve)
          })
        })
        
        // Create canvas and copy image
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          throw new Error('Cannot get canvas context')
        }
        
        canvas.width = canvasElement.width || canvasElement.clientWidth
        canvas.height = canvasElement.height || canvasElement.clientHeight
        ctx.drawImage(canvasElement, 0, 0, canvas.width, canvas.height)
        capturedImage = canvas.toDataURL('image/png')
        console.log('[DICOMViewer] Captured without annotations as fallback')
      }
      
      if (!capturedImage || capturedImage.length < 100) {
        throw new Error('Captured image is invalid or too small')
      }
      
      console.log('[DICOMViewer] Slice captured successfully, length:', capturedImage.length)
      
      // Get current slice annotations and measurements
      const sliceAnnotations = annotations.filter(a => a.sliceIndex === currentSlice)
      const sliceMeasurements = measurements.filter(m => true) // Measurements don't have sliceIndex
      
      // Save with annotations and measurements
      // Use the actual caseId prop, not patient_id from metadata
      addSlice({
        caseId: caseId || metadata.uids?.patient_id || 'unknown',
        sliceIndex: currentSlice,
        imageUrl: capturedImage, // Use captured image with annotations
        windowWidth: windowWidth,
        windowCenter: windowCenter,
        zoom: zoom,
        annotations: sliceAnnotations,
        measurements: sliceMeasurements,
        metadata: {
          patientId: metadata.uids?.patient_id || '',
          studyDate: metadata.uids?.study_uid ? new Date().toISOString().split('T')[0].replace(/-/g, '') : undefined,
          sliceThickness: metadata.slice_thickness,
          modality: metadata.modality || 'CT',
          pixelSpacing: metadata.pixel_spacing
        }
      })
      
      // Show notification
      setToastMessage(`Slice ${currentSlice + 1} saved to film`)
      console.log('[DICOMViewer] ✅ Slice saved to film successfully')
    } catch (error: any) {
      console.error('[DICOMViewer] ❌ Failed to capture slice:', error)
      console.error('[DICOMViewer] Error details:', {
        message: error?.message,
        stack: error?.stack,
        hasRenderingEngine: !!renderingEngineRef.current,
        hasMetadata: !!metadata,
        currentSlice
      })
      setToastMessage(`Failed to save slice: ${error?.message || 'Unknown error'}`)
    }
  }, [caseId, currentSlice, metadata, windowWidth, windowCenter, zoom, addSlice, captureSliceWithAnnotations, annotations, measurements])

  // Reset view
  const resetView = async () => {
    setZoom(1)
    setPanX(0)
    setPanY(0)
    if (metadata?.window) {
      setWindowWidth(metadata.window.width)
      setWindowCenter(metadata.window.center)
    } else {
      setWindowWidth(400)
      setWindowCenter(40)
    }
    setIsInverted(false)
    
    // Reset Cornerstone viewport camera
    if (renderingEngineRef.current) {
      try {
        const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
        if (viewport) {
          // Reset camera to fit image
          if (typeof viewport.resetCamera === 'function') {
            viewport.resetCamera()
            const camera = viewport.getCamera?.()
            if (camera?.parallelScale) {
              baseParallelScaleRef.current = camera.parallelScale
            }
          }
          
          // Clear Cornerstone annotations
          try {
            const csTools = await import('@cornerstonejs/tools')
            const { annotation } = csTools as any
            if (annotation && annotation.state) {
              // Get viewport element to ensure it's enabled
              const viewportElement = viewport.element
              if (!viewportElement) {
                console.warn('[DICOMViewer] Viewport element not available for annotation clearing')
              } else {
                // Try to get annotations with the viewport element
                try {
                  const annotations = annotation.state.getAnnotations(
                    viewportElement,
                    'dicom-viewer-tool-group'
                  ) || []
                  
                  if (annotations.length > 0) {
                    annotations.forEach((ann: any) => {
                      try {
                        annotation.state.removeAnnotation(ann.annotationUID)
                      } catch (e) {
                        console.warn('[DICOMViewer] Failed to remove annotation:', ann.annotationUID, e)
                      }
                    })
                    viewport.render()
                    console.log('[DICOMViewer] Cleared', annotations.length, 'Cornerstone annotations')
                  }
                } catch (e) {
                  // Fallback: try without element
                  console.log('[DICOMViewer] Trying alternative method to clear annotations')
                  try {
                    const allAnnotations = annotation.state.getAllAnnotations() || []
                    const relevantAnnotations = allAnnotations.filter((ann: any) => {
                      return ann.metadata && ann.metadata.viewportId === 'dicom-viewer-viewport'
                    })
                    relevantAnnotations.forEach((ann: any) => {
                      try {
                        annotation.state.removeAnnotation(ann.annotationUID)
                      } catch (e2) {
                        console.warn('[DICOMViewer] Failed to remove annotation:', ann.annotationUID, e2)
                      }
                    })
                    if (relevantAnnotations.length > 0) {
                      viewport.render()
                      console.log('[DICOMViewer] Cleared', relevantAnnotations.length, 'Cornerstone annotations (fallback method)')
                    }
                  } catch (e2) {
                    console.warn('[DICOMViewer] Failed to clear Cornerstone annotations (all methods failed):', e2)
                  }
                }
              }
            }
          } catch (e) {
            console.warn('[DICOMViewer] Failed to clear Cornerstone annotations:', e)
          }
          
          // Remove invert filter
          const canvas = viewport.element?.querySelector('canvas')
          if (canvas) {
            canvas.style.filter = 'none'
          }
          
          viewport.render()
        }
      } catch (err) {
        console.error('[DICOMViewer] Failed to reset viewport:', err)
      }
    }
    
    // Clear custom annotations and measurements
    setAnnotations([])
    setActiveAnnotation(null)
    setMeasurements([])
    setCurrentMeasurement(null)
  }

  // Manual play/pause toggle - for user-controlled playback in VIEWER
  const togglePlay = () => {
    if (isPlaying) {
      // Pause manual playback
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current)
        playIntervalRef.current = null
      }
      setIsPlaying(false)
    } else {
      // Start manual playback
      const maxSlices = totalSlices
      if (maxSlices <= 0) {
        console.warn('[DICOMViewer] Cannot play: no slices available')
        return
      }
      
      setIsPlaying(true)
      const minSlice = 0
      const maxSlice = maxSlices - 1
      
      playIntervalRef.current = setInterval(() => {
        setCurrentSlice(prev => {
          const next = prev + 1
          return next > maxSlice ? minSlice : next
        })
      }, 1000 / fps)
    }
  }

  // Cleanup
  useEffect(() => {
    return () => {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current)
      }
    }
  }, [])

  // NOTE: Scan playback is handled in EXAMINATION tab (ImageDisplayArea), NOT in VIEWER
  // VIEWER only has manual play/pause controlled by user

  
  // Cleanup HU fetch timeout
  useEffect(() => {
    return () => {
      if (huFetchTimeoutRef.current) {
        clearTimeout(huFetchTimeoutRef.current)
      }
    }
  }, [])

  // Calculate values
  const maxSlices = totalSlices
  const effectiveMin = 0
  const effectiveMax = maxSlices > 0 ? maxSlices - 1 : 0
  const effectiveTotal = maxSlices
  const relativeSlice = maxSlices > 0 ? currentSlice + 1 : 0

  // Calculate CSS filter for window/level (keeping for backward compatibility)
  // Note: Backend already applies proper windowing, but CSS filters allow real-time adjustment
  const brightness = 1 + (windowCenter - 40) / 200
  const contrast = windowWidth / 400

  // Image rendering quality settings
  const imageRendering = imageQuality === 'pixel-perfect' 
    ? (zoom >= 1 ? 'pixelated' : 'crisp-edges')
    : 'auto'

  
  // Calculate zoom to 1:1 pixel ratio
  const zoomTo1to1 = useCallback(() => {
    if (!containerRef.current || !metadata) return
    
    const container = containerRef.current
    const containerWidth = container.clientWidth
    const containerHeight = container.clientHeight
    
    // Calculate zoom needed for 1:1 pixel display
    const pixelWidth = metadata.cols
    const pixelHeight = metadata.rows
    
    const zoomX = containerWidth / pixelWidth
    const zoomY = containerHeight / pixelHeight
    const zoom1to1 = Math.min(zoomX, zoomY)
    
    setZoom(zoom1to1)
    setPanX(0)
    setPanY(0)
  }, [metadata])

  // Tool button component
  const ToolButton = ({ tool, icon, label }: { tool: ToolType; icon: string; label: string }) => {
    const isAnnotationTool = tool === 'arrow' || tool === 'text' || tool === 'circle' || 
                             tool === 'rectangle' || tool === 'line' || tool === 'freehand'
    
    return (
      <button
        onClick={() => {
          console.log('Tool button clicked:', tool, 'Current tool:', activeTool)
          setActiveTool(tool)
          if (!isAnnotationTool && tool !== 'measure' && tool !== 'roi' && tool !== 'ellipticalRoi' && 
              tool !== 'circleRoi' && tool !== 'arrowAnnotate' && tool !== 'probe' && tool !== 'angle') {
            setCurrentMeasurement(null)
            setActiveAnnotation(null)
          }
          // Don't clear active annotation when switching between annotation tools
          if (isAnnotationTool && activeAnnotation) {
            // Complete current annotation before switching
            if (activeAnnotation.points.length >= 2) {
              setAnnotations(prev => [...prev, activeAnnotation])
            }
            setActiveAnnotation(null)
          }
        }}
        className={`flex flex-col items-center justify-center p-2 rounded transition ${
          activeTool === tool
            ? 'bg-blue-600 text-white'
            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
        }`}
        title={label}
      >
        <span className="text-lg">{icon}</span>
        <span className="text-[10px] mt-0.5">{label}</span>
      </button>
    )
  }
  
  // Convert pixel coordinates to screen coordinates using Cornerstone3D
  const pixelToScreen = useCallback((pixelX: number, pixelY: number): { x: number; y: number } | null => {
    if (!metadata) return null
    
    try {
      // Use Cornerstone3D viewport for accurate coordinate conversion
      if (renderingEngineRef.current && cornerstoneViewportRef.current) {
        const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
        if (viewport) {
          const imageData = viewport.getImageData()
          
          let worldPoint: [number, number, number]
          
          if (imageData && imageData.origin && imageData.spacing) {
            // Convert pixel index to world coordinates using image origin and spacing
            worldPoint = [
              imageData.origin[0] + pixelX * imageData.spacing[0],
              imageData.origin[1] + pixelY * imageData.spacing[1],
              imageData.origin[2] || 0
            ]
          } else if (typeof viewport.indexToWorld === 'function') {
            // Use Cornerstone's indexToWorld if available
            worldPoint = viewport.indexToWorld([pixelX, pixelY, currentSlice])
          } else {
            // Fallback: treat pixel as world (may not be accurate)
            worldPoint = [pixelX, pixelY, 0]
          }
          
          // Convert world coordinates to canvas coordinates
          const canvasPoint = viewport.worldToCanvas(worldPoint)
          
          // Get container position to convert canvas coords to screen coords
          const container = cornerstoneViewportRef.current
          const containerRect = container.getBoundingClientRect()
          
          return { 
            x: containerRect.left + canvasPoint[0], 
            y: containerRect.top + canvasPoint[1] 
          }
        }
      }
      
      // Fallback: manual calculation if Cornerstone is not ready
      if (imageRef.current) {
        const containerRect = imageRef.current.getBoundingClientRect()
        const centerX = containerRect.width / 2
        const centerY = containerRect.height / 2
        const screenX = containerRect.left + centerX + (pixelX - metadata.cols / 2) * zoom + panX
        const screenY = containerRect.top + centerY + (pixelY - metadata.rows / 2) * zoom + panY
      return { x: screenX, y: screenY }
      }
      
      return null
    } catch (error) {
      console.error('Error converting pixel to screen:', error)
      return null
    }
  }, [metadata, zoom, panX, panY, currentSlice])

  // Draw measurement overlay
  const drawMeasurement = useCallback((measurement: Measurement, isCurrent: boolean = false) => {
    if (!imageRef.current || !metadata) return null
    
    const points = measurement.points
    if (points.length === 0) return null
    
    const color = isCurrent ? '#10b981' : '#3b82f6'
    
    if (measurement.type === 'distance' && points.length === 2) {
      const [p1, p2] = points
      const screenP1 = pixelToScreen(p1.x, p1.y)
      const screenP2 = pixelToScreen(p2.x, p2.y)
      
      if (!screenP1 || !screenP2) return null
      
      const midX = (screenP1.x + screenP2.x) / 2
      const midY = (screenP1.y + screenP2.y) / 2
      
      return (
        <g key={measurement.id}>
          <line
            x1={screenP1.x}
            y1={screenP1.y}
            x2={screenP2.x}
            y2={screenP2.y}
            stroke={color}
            strokeWidth="2"
            strokeDasharray={isCurrent ? "5,5" : "none"}
          />
          <circle cx={screenP1.x} cy={screenP1.y} r="4" fill={color} />
          <circle cx={screenP2.x} cy={screenP2.y} r="4" fill={color} />
          {measurement.value !== undefined && (
            <text
              x={midX}
              y={midY - 10}
              fill={color}
              fontSize="12"
              fontWeight="bold"
              textAnchor="middle"
              style={{ textShadow: '1px 1px 2px black' }}
            >
              {measurement.value.toFixed(2)} mm
            </text>
          )}
        </g>
      )
    }
    
    if (measurement.type === 'roi' && points.length >= 2) {
      const screenPoints = points.map(p => pixelToScreen(p.x, p.y)).filter(p => p !== null) as Array<{ x: number; y: number }>
      if (screenPoints.length < 2) return null
      
      const pathData = `M ${screenPoints.map(p => `${p.x},${p.y}`).join(' L ')} ${screenPoints.length > 2 ? 'Z' : ''}`
      return (
        <g key={measurement.id}>
          <path
            d={pathData}
            fill={color}
            fillOpacity="0.2"
            stroke={color}
            strokeWidth="2"
            strokeDasharray={isCurrent ? "5,5" : "none"}
          />
          {screenPoints.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="4" fill={color} />
          ))}
        </g>
      )
    }
    
    return null
  }, [pixelToScreen, metadata])

  // Window presets for 4-window view
  const windowPresets = [
    { name: 'Bone', width: 2000, center: 300 },
    { name: 'Brain', width: 80, center: 40 },
    { name: 'Soft Tissue', width: 400, center: 40 },
    { name: 'Lung', width: 1500, center: -600 }
  ]

  return (
    <div className="flex h-full w-full bg-slate-900 min-h-0">
      {/* 4-Window View */}
      {show4WindowView && totalSlices > 0 ? (
        <div className="flex-1 grid grid-cols-2 gap-2 p-2 bg-slate-900 overflow-hidden">
          {windowPresets.map((preset) => (
            <div
              key={preset.name}
              className="bg-black relative overflow-hidden border border-slate-700 rounded"
            >
              {/* Window label */}
              <div className="absolute top-2 left-2 z-10 bg-black/70 text-white text-xs px-2 py-1 rounded">
                {preset.name}
              </div>
              {/* Viewport for this window */}
              <div
                className="absolute inset-0"
                id={`dicom-viewer-viewport-${preset.name.toLowerCase().replace(' ', '-')}`}
                style={{
                  width: '100%',
                  height: '100%',
                  minWidth: '100px',
                  minHeight: '200px'
                }}
              />
              {/* Window/Level info */}
              <div className="absolute bottom-2 left-2 z-10 bg-black/70 text-white text-xs px-2 py-1 rounded">
                W: {preset.width} / C: {preset.center}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Main Viewer */
        <div 
          ref={containerRef}
          className="flex-1 bg-black relative overflow-hidden select-none min-h-0"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            handleMouseUp()
            setPixelInfo(null)
          }}
          style={{ 
            cursor: isDragging ? 'grabbing' : activeTool === 'pan' ? 'grab' : 'crosshair'
          }}
        >
        {/* Current Frame - MUST have explicit height for Cornerstone */}
        <div ref={imageRef} className="absolute inset-0">
          {/* ALWAYS render the Cornerstone viewport element - it needs to exist for sizing */}
          <div 
            ref={cornerstoneViewportRef}
            className="absolute inset-0"
            id="dicom-viewer-viewport"
            style={{ 
              width: '100%',
              height: '100%',
              minWidth: '100px',
              minHeight: '200px',
              visibility: (!show4WindowView && totalSlices > 0 && !loading && !error) ? 'visible' : show4WindowView ? 'hidden' : (totalSlices > 0 && !loading && !error) ? 'visible' : 'hidden'
            }}
          />
          
          {/* Overlay messages/status */}
          {/* Only show loading if tab is active and we don't have data yet */}
          {loading && isActive && totalSlices === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black text-slate-400 z-20">
              <div className="text-center">
              <div className="mb-2">Loading DICOM slices…</div>
              </div>
            </div>
          ) : error ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black z-20">
            <div className="text-red-400 text-center px-4">
              <div className="mb-2 font-semibold">Error: {error}</div>
                {totalSlices === 0 && (
                  <div className="text-xs text-slate-400 mb-2">No DICOM files loaded. Please load DICOM files first.</div>
                )}
              <button
                onClick={() => {
                  console.log('DICOMViewer: Retry button clicked')
                    loadDicomData()
                }}
                className="px-3 py-1.5 bg-slate-700 rounded text-sm hover:bg-slate-600 transition"
              >
                Retry
              </button>
            </div>
            </div>
          ) : totalSlices > 0 ? (
            <>
              {!cornerstoneInitializedRef.current && (
                <div className="absolute inset-0 flex items-center justify-center bg-black text-slate-400 z-20">
                  <div className="text-center">
                    <div className="mb-2">Initializing Cornerstone3D...</div>
                    <div className="text-xs text-slate-500">Loading DICOM files</div>
                  </div>
                </div>
              )}
              {/* Measurement Overlay */}
              {metadata && (
                <svg
                  className="absolute inset-0 pointer-events-none z-10"
                  style={{ width: '100%', height: '100%' }}
                >
                  {measurements.map(m => drawMeasurement(m))}
                  {currentMeasurement && drawMeasurement(currentMeasurement, true)}
                </svg>
              )}
              
              {/* Annotation Overlay */}
              {metadata && (
                <AnnotationLayer
                  annotations={annotations.filter(a => a.sliceIndex === currentSlice)}
                  activeAnnotation={activeAnnotation && activeAnnotation.sliceIndex === currentSlice ? activeAnnotation : null}
                  pixelToScreen={pixelToScreen}
                />
              )}
            </>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-black text-slate-400 z-20">
              <div className="text-center">
                <div className="mb-2">No DICOM files loaded</div>
                <div className="text-xs text-slate-500 mt-1">Select a case to load images (Option 2: backend streaming)</div>
                    <div className="text-xs text-slate-500 mt-1">Total slices: {totalSlices}</div>
              </div>
            </div>
          )}
        </div>
        
        {/* Pixel Value Display with HU Values */}
        {pixelInfo && metadata && (
          <div
            className="absolute bg-black/90 text-white text-xs font-mono px-3 py-2 rounded z-20 pointer-events-none shadow-lg border border-slate-600"
            style={{
              left: `${pixelInfo.x + 15}px`,
              top: `${pixelInfo.y - 100}px`,
              minWidth: '200px'
            }}
          >
            <div className="space-y-1">
              <div className="text-slate-300 text-[10px] uppercase">Coordinates</div>
              <div>X: {pixelInfo.pixelX} Y: {pixelInfo.pixelY}</div>
              
              {metadata.pixel_spacing && (
                <div className="text-slate-300 text-[10px]">
                  {((pixelInfo.pixelX - metadata.cols / 2) * metadata.pixel_spacing[1]).toFixed(2)} mm,{' '}
                  {((pixelInfo.pixelY - metadata.rows / 2) * metadata.pixel_spacing[0]).toFixed(2)} mm
                </div>
              )}
              
              {/* HU Value Display */}
              <div className="border-t border-slate-600 mt-2 pt-2">
                <div className="text-slate-300 text-[10px] uppercase mb-1">HU Value</div>
                {loadingHU ? (
                  <div className="text-slate-400 text-[10px]">Loading...</div>
                ) : huValue && typeof huValue.hu_value === 'number' ? (
                  <>
                    <div className="text-yellow-300 font-bold text-sm">
                      {huValue.hu_value.toFixed(1)} HU
                    </div>
                    <div className="text-green-400 text-[10px] mt-1 font-semibold">
                      {huValue.tissue_type || 'Unknown'}
                    </div>
                  </>
                ) : (
                  <div className="text-slate-500 text-[10px]">Hover to see HU</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Top-Left Metadata */}
        <div className="absolute top-2 left-2 text-white text-xs font-mono z-10 pointer-events-none">
          {metadata && (
            <div className="space-y-0.5 text-shadow">
              <div className="text-yellow-300 font-semibold">{metadata.modality}</div>
              <div>{metadata.uids.patient_id || 'Unknown Patient'}</div>
              <div>{metadata.rows} × {metadata.cols}</div>
              <div>Slices: {metadata.num_slices}</div>
              <div>Thick: {metadata.slice_thickness.toFixed(2)} mm</div>
            </div>
          )}
        </div>

        {/* Top-Right Info */}
        <div className="absolute top-2 right-2 text-white text-xs font-mono z-10 pointer-events-none text-right">
          <div className="space-y-0.5 text-shadow">
            <div className="text-cyan-300">{relativeSlice} / {effectiveTotal}</div>
            <div>WW: {Math.round(windowWidth)}</div>
            <div>WL: {Math.round(windowCenter)}</div>
            <div>Zoom: {(zoom * 100).toFixed(0)}%</div>
          </div>
        </div>

        {/* Orientation Markers */}
        <div className="absolute top-1/2 left-2 -translate-y-1/2 text-white text-lg font-bold z-10 text-shadow pointer-events-none">R</div>
        <div className="absolute top-1/2 right-8 -translate-y-1/2 text-white text-lg font-bold z-10 text-shadow pointer-events-none">L</div>
        <div className="absolute top-12 left-1/2 -translate-x-1/2 text-white text-lg font-bold z-10 text-shadow pointer-events-none">A</div>
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 text-white text-lg font-bold z-10 text-shadow pointer-events-none">P</div>


        {/* Bottom Controls - Manual Play/Pause */}
        <div className="absolute bottom-2 right-2 flex gap-2 z-10">
          <button
            onClick={togglePlay}
            className="px-3 py-1 bg-blue-600/80 hover:bg-blue-500 text-white text-xs rounded"
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>
        </div>

        {/* Active Tool Indicator */}
        <div className="absolute bottom-2 left-2 z-10">
          <span className="bg-black/70 text-white text-xs px-2 py-1 rounded capitalize">
            {activeTool === 'windowLevel' ? 'W/L' : activeTool}
          </span>
        </div>
      </div>
      )}

      {/* Right Panel */}
      <div className="w-52 min-w-52 shrink-0 bg-slate-950 border-l border-slate-800 flex flex-col min-h-0 overflow-hidden">
        {/* Scrollable controls */}
        <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Tools Section */}
        <div className="p-3 border-b border-slate-800">
          <h3 className="text-xs font-semibold text-slate-200 mb-2">Tools</h3>
          <div className="grid grid-cols-4 gap-1">
            <ToolButton tool="windowLevel" icon="◐" label="W/L" />
            <ToolButton tool="zoom" icon="🔍" label="Zoom" />
            <ToolButton tool="pan" icon="✋" label="Pan" />
            <ToolButton tool="scroll" icon="↕" label="Scroll" />
          </div>
          
          {/* Annotation / Measurement Tools */}
          <div className="mt-2">
            <h4 className="text-xs font-semibold text-slate-200 mb-1">Annotations</h4>
            <div className="grid grid-cols-2 gap-1">
              {/* Length measurement */}
              <ToolButton tool="measure" icon="📏" label="Length" />
              {/* Rectangle ROI */}
              <ToolButton tool="roi" icon="▭" label="Rect ROI" />
              {/* Elliptical ROI */}
              <ToolButton tool="ellipticalRoi" icon="⬭" label="Ellipse" />
              {/* Circle ROI */}
              <ToolButton tool="circleRoi" icon="○" label="Circle" />
              {/* Arrow annotation */}
              <ToolButton tool="arrowAnnotate" icon="➜" label="Arrow" />
              {/* Probe (pixel value) */}
              <ToolButton tool="probe" icon="🔍" label="Probe" />
              {/* Angle measurement */}
              <ToolButton tool="angle" icon="∠" label="Angle" />
            </div>
          </div>
          
          {/* Quick Actions */}
          <div className="flex gap-1 mt-2">
            {/* Rotate counter-clockwise */}
            <button
              onClick={() => {
                if (!renderingEngineRef.current) return
                const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
                if (!viewport) return
                const props = typeof viewport.getProperties === 'function' ? viewport.getProperties() : {}
                const currentRotation = props.rotation || 0
                if (typeof viewport.setProperties === 'function') {
                  viewport.setProperties({ rotation: (currentRotation - 90 + 360) % 360 })
                } else if (typeof viewport.setViewPresentation === 'function') {
                  viewport.setViewPresentation({ rotation: (currentRotation - 90 + 360) % 360 })
                }
                viewport.render?.()
              }}
              className="px-2 py-1.5 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700"
            >
              ↺ 90°
            </button>
            {/* Rotate clockwise */}
            <button
              onClick={() => {
                if (!renderingEngineRef.current) return
                const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
                if (!viewport) return
                const props = typeof viewport.getProperties === 'function' ? viewport.getProperties() : {}
                const currentRotation = props.rotation || 0
                if (typeof viewport.setProperties === 'function') {
                  viewport.setProperties({ rotation: (currentRotation + 90) % 360 })
                } else if (typeof viewport.setViewPresentation === 'function') {
                  viewport.setViewPresentation({ rotation: (currentRotation + 90) % 360 })
                }
                viewport.render?.()
              }}
              className="px-2 py-1.5 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700"
            >
              ↻ 90°
            </button>
            <button
              onClick={resetView}
              className="flex-1 px-2 py-1.5 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700"
            >
              Reset
            </button>
            <button
              onClick={() => setIsInverted(!isInverted)}
              className={`flex-1 px-2 py-1.5 rounded text-xs ${
                isInverted ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              Invert
            </button>
          </div>
          
          {/* 4-Window View Button */}
          <button
            onClick={() => setShow4WindowView(!show4WindowView)}
            className={`w-full mt-2 px-2 py-1.5 rounded text-xs font-medium transition ${
              show4WindowView 
                ? 'bg-blue-600 text-white' 
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {show4WindowView ? 'Exit 4-Window' : '4-Window View'}
          </button>
          
          {/* Save to Film */}
          <button
            onClick={handleSaveToFilm}
            disabled={!cornerstoneInitializedRef.current || !metadata}
            className="w-full mt-2 px-2 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white rounded text-xs font-medium transition flex items-center justify-center gap-1"
            title="Save current slice to film"
          >
            <span>📷</span>
            <span>Save to Film</span>
          </button>
          
          {/* Clear Measurements */}
          {measurements.length > 0 && (
            <button
              onClick={() => {
                setMeasurements([])
                setCurrentMeasurement(null)
              }}
              className="w-full mt-2 px-2 py-1.5 bg-red-800 text-white rounded text-xs hover:bg-red-700"
            >
              Clear Measurements
            </button>
          )}
          
          {/* Clear Annotations */}
          {annotations.filter(a => a.sliceIndex === currentSlice).length > 0 && (
            <button
              onClick={() => {
                setAnnotations(annotations.filter(a => a.sliceIndex !== currentSlice))
                setActiveAnnotation(null)
              }}
              className="w-full mt-2 px-2 py-1.5 bg-red-800 text-white rounded text-xs hover:bg-red-700"
            >
              Clear Annotations
            </button>
          )}
          
          {/* Clear Annotations */}
          <button
            onClick={async () => {
              try {
                if (!renderingEngineRef.current) {
                  console.warn('[DICOMViewer] Rendering engine not available')
                  return
                }
                
                const viewport = renderingEngineRef.current.getViewport('dicom-viewer-viewport') as any
                if (!viewport) {
                  console.warn('[DICOMViewer] Viewport not available')
                  return
                }
                
                const csTools = await import('@cornerstonejs/tools')
                const { annotation, ToolGroupManager } = csTools as any
                if (!annotation || !annotation.state) {
                  console.warn('[DICOMViewer] Annotation state not available')
                  return
                }
                
                // Get viewport element to ensure it's enabled
                const viewportElement = viewport.element
                if (!viewportElement) {
                  console.warn('[DICOMViewer] Viewport element not available')
                  return
                }
                
                let clearedCount = 0
                
                // Method 1: Try getting annotations by tool group
                try {
                  const toolGroup = ToolGroupManager.getToolGroup('dicom-viewer-tool-group')
                  if (toolGroup) {
                    // Get all annotations for this viewport element
                    const annotations = annotation.state.getAnnotations(viewportElement, 'dicom-viewer-tool-group') || []
                    console.log('[DICOMViewer] Found', annotations.length, 'annotations via tool group')
                    
                    annotations.forEach((ann: any) => {
                      try {
                        annotation.state.removeAnnotation(ann.annotationUID, viewportElement)
                        clearedCount++
                      } catch (e: any) {
                        // Try without element
                        try {
                          annotation.state.removeAnnotation(ann.annotationUID)
                          clearedCount++
                        } catch (e2) {
                          console.warn('[DICOMViewer] Failed to remove annotation:', ann.annotationUID, e2)
                        }
                      }
                    })
                  }
                } catch (e) {
                  console.log('[DICOMViewer] Method 1 failed, trying alternative:', e)
                }
                
                // Method 2: Try getting all annotations and filter by viewport
                if (clearedCount === 0) {
                  try {
                    const allAnnotations = annotation.state.getAllAnnotations() || []
                    console.log('[DICOMViewer] Found', allAnnotations.length, 'total annotations')
                    
                    // Log first annotation structure for debugging
                    if (allAnnotations.length > 0) {
                      console.log('[DICOMViewer] Sample annotation structure:', {
                        annotationUID: allAnnotations[0].annotationUID,
                        metadata: allAnnotations[0].metadata,
                        toolName: allAnnotations[0].metadata?.toolName,
                        viewportId: allAnnotations[0].metadata?.viewportId,
                        referencedImageId: allAnnotations[0].metadata?.referencedImageId,
                        viewportElement: allAnnotations[0].metadata?.viewportElement,
                        hasElement: !!allAnnotations[0].metadata?.viewportElement
                      })
                    }
                    
                    allAnnotations.forEach((ann: any) => {
                      try {
                        // Check if annotation belongs to our viewport - try multiple matching strategies
                        const metadata = ann.metadata || {}
                        const viewportId = metadata.viewportId || metadata.referencedImageId
                        const annElement = metadata.viewportElement || metadata.element
                        const toolName = metadata.toolName
                        
                        // Match by viewport ID, element reference, or tool group membership
                        const isOurViewport = 
                          viewportId === 'dicom-viewer-viewport' ||
                          viewportElement === annElement ||
                          (toolName && ['Length', 'RectangleROI', 'EllipticalROI', 'CircleROI', 'ArrowAnnotate', 'Probe', 'Angle'].includes(toolName))
                        
                        if (isOurViewport) {
                          try {
                            annotation.state.removeAnnotation(ann.annotationUID, viewportElement)
                            clearedCount++
                          } catch (e) {
                            // Try without element
                            try {
                              annotation.state.removeAnnotation(ann.annotationUID)
                              clearedCount++
                            } catch (e2) {
                              console.warn('[DICOMViewer] Failed to remove annotation:', ann.annotationUID, e2)
                            }
                          }
                        }
                      } catch (e) {
                        // Ignore individual failures
                      }
                    })
                    
                    if (clearedCount > 0) {
                      console.log('[DICOMViewer] Method 2 cleared', clearedCount, 'annotations')
                    }
                  } catch (e) {
                    console.log('[DICOMViewer] Method 2 failed:', e)
                  }
                }
                
                // Method 3: Try removing by individual tool names
                if (clearedCount === 0) {
                  try {
                    const toolGroup = ToolGroupManager.getToolGroup('dicom-viewer-tool-group')
                    if (toolGroup) {
                      // Get annotations for all tools in the group
                      const toolNames = ['Length', 'RectangleROI', 'EllipticalROI', 'CircleROI', 'ArrowAnnotate', 'Probe', 'Angle']
                      toolNames.forEach((toolName) => {
                        try {
                          const toolAnnotations = annotation.state.getAnnotations(viewportElement, toolName) || []
                          toolAnnotations.forEach((ann: any) => {
                            try {
                              annotation.state.removeAnnotation(ann.annotationUID, viewportElement)
                              clearedCount++
                            } catch (e) {
                              // Try without element
                              try {
                                annotation.state.removeAnnotation(ann.annotationUID)
                                clearedCount++
                              } catch (e2) {
                                // Ignore individual failures
                              }
                            }
                          })
                        } catch (e) {
                          // Ignore tool-specific failures
                        }
                      })
                      
                      if (clearedCount > 0) {
                        console.log('[DICOMViewer] Method 3 cleared', clearedCount, 'annotations')
                      }
                    }
                  } catch (e) {
                    console.log('[DICOMViewer] Method 3 failed:', e)
                  }
                }
                
                // Method 4: Aggressive approach - remove all annotations if they have our tool names
                if (clearedCount === 0) {
                  try {
                    const allAnnotations = annotation.state.getAllAnnotations() || []
                    const toolNames = ['Length', 'RectangleROI', 'EllipticalROI', 'CircleROI', 'ArrowAnnotate', 'Probe', 'Angle']
                    
                    allAnnotations.forEach((ann: any) => {
                      const toolName = ann.metadata?.toolName
                      if (toolName && toolNames.includes(toolName)) {
                        try {
                          annotation.state.removeAnnotation(ann.annotationUID, viewportElement)
                          clearedCount++
                        } catch (e) {
                          try {
                            annotation.state.removeAnnotation(ann.annotationUID)
                            clearedCount++
                          } catch (e2) {
                            // Ignore failures
                          }
                        }
                      }
                    })
                    
                    if (clearedCount > 0) {
                      console.log('[DICOMViewer] Method 4 cleared', clearedCount, 'annotations by tool name')
                    }
                  } catch (e) {
                    console.log('[DICOMViewer] Method 4 failed:', e)
                  }
                }
                
                if (clearedCount > 0) {
                  viewport.render()
                  console.log('[DICOMViewer] ✅ Cleared', clearedCount, 'Cornerstone annotations')
                } else {
                  console.log('[DICOMViewer] No Cornerstone annotations found to clear')
                }
              } catch (e) {
                console.warn('[DICOMViewer] Failed to clear Cornerstone annotations:', e)
              }
            }}
            className="w-full mt-2 px-2 py-1.5 bg-orange-800 text-white rounded text-xs hover:bg-orange-700"
          >
            Clear Annotations
          </button>
        </div>

        {/* Window/Level Controls */}
        <div className="p-3 border-b border-slate-800">
          <h3 className="text-xs font-semibold text-slate-200 mb-2">Window/Level</h3>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-slate-400">Width: {Math.round(windowWidth)}</label>
              <input
                type="range"
                min="1"
                max="4000"
                value={windowWidth}
                onChange={(e) => setWindowWidth(Number(e.target.value))}
                className="w-full h-2 cursor-pointer"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400">Center: {Math.round(windowCenter)}</label>
              <input
                type="range"
                min="-1000"
                max="3000"
                value={windowCenter}
                onChange={(e) => setWindowCenter(Number(e.target.value))}
                className="w-full h-2 cursor-pointer"
              />
            </div>
          </div>
          
          {/* Presets */}
          <div className="mt-2">
            <label className="text-xs text-slate-400 mb-1 block">Presets</label>
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() => { setWindowWidth(400); setWindowCenter(40); }}
                className="px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700"
              >
                Soft Tissue
              </button>
              <button
                onClick={() => { setWindowWidth(1500); setWindowCenter(-600); }}
                className="px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700"
              >
                Lung
              </button>
              <button
                onClick={() => { setWindowWidth(2000); setWindowCenter(300); }}
                className="px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700"
              >
                Bone
              </button>
              <button
                onClick={() => { setWindowWidth(80); setWindowCenter(40); }}
                className="px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700"
              >
                Brain
              </button>
            </div>
          </div>
        </div>

        {/* Zoom Control */}
        <div className="p-3 border-b border-slate-800">
          <h3 className="text-xs font-semibold text-slate-200 mb-2">Zoom: {(zoom * 100).toFixed(0)}%</h3>
          <input
            type="range"
            min="10"
            max="500"
            value={zoom * 100}
            onChange={(e) => setZoom(Number(e.target.value) / 100)}
            className="w-full h-2 cursor-pointer"
          />
          <div className="flex gap-1 mt-2">
            <button
              onClick={() => setZoom(prev => Math.max(0.1, prev / 1.2))}
              className="flex-1 px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700"
            >
              -
            </button>
            <button
              onClick={fitToScreen}
              className="flex-1 px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700"
            >
              Fit
            </button>
            <button
              onClick={zoomTo1to1}
              className="flex-1 px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700"
              title="Zoom to 1:1 pixel ratio"
            >
              1:1
            </button>
            <button
              onClick={() => setZoom(prev => Math.min(10, prev * 1.2))}
              className="flex-1 px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700"
            >
              +
            </button>
          </div>
        </div>
        
        {/* Image Quality Settings */}
        <div className="p-3 border-b border-slate-800">
          <h3 className="text-xs font-semibold text-slate-200 mb-2">Image Quality</h3>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-slate-200 text-xs cursor-pointer">
              <input
                type="radio"
                name="imageQuality"
                value="pixel-perfect"
                checked={imageQuality === 'pixel-perfect'}
                onChange={() => setImageQuality('pixel-perfect')}
                className="accent-blue-500"
              />
              <span>Pixel Perfect</span>
            </label>
            <label className="flex items-center gap-2 text-slate-200 text-xs cursor-pointer">
              <input
                type="radio"
                name="imageQuality"
                value="smooth"
                checked={imageQuality === 'smooth'}
                onChange={() => setImageQuality('smooth')}
                className="accent-blue-500"
              />
              <span>Smooth (Interpolated)</span>
            </label>
          </div>
        </div>
        </div>

        {/* Slice Navigation */}
        <div className="shrink-0 p-3 border-t border-slate-800 bg-slate-950">
          <h3 className="text-xs font-semibold text-slate-200 mb-2">Slice Navigation</h3>
          
          <div className="flex items-center justify-center">
            <input
              type="range"
              min={effectiveMin}
              max={effectiveMax}
              value={currentSlice}
              onChange={(e) => handleSliceChange(Number(e.target.value))}
              className="h-28 cursor-pointer"
              style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
              disabled={maxSlices === 0}
            />
          </div>
          
          <div className="text-center text-xs text-slate-300 mt-2 font-mono">
            {relativeSlice} / {effectiveTotal}
          </div>
          
          <div className="flex gap-1 mt-2">
            <button
              onClick={() => handleSliceChange(currentSlice - 1)}
              disabled={currentSlice <= effectiveMin}
              className="flex-1 px-2 py-1.5 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700 disabled:opacity-50"
            >
              ▲ Prev
            </button>
            <button
              onClick={() => handleSliceChange(currentSlice + 1)}
              disabled={currentSlice >= effectiveMax}
              className="flex-1 px-2 py-1.5 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700 disabled:opacity-50"
            >
              ▼ Next
            </button>
          </div>
        </div>
      </div>
      
      {/* Toast Notification */}
      {toastMessage && (
        <Toast 
          message={toastMessage} 
          onClose={() => setToastMessage(null)} 
        />
      )}
    </div>
  )
}

export default DICOMViewer
