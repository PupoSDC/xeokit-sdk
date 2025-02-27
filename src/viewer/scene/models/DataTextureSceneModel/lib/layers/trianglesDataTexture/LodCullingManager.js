import { DataTextureSceneModel }  from "../../../DataTextureSceneModel.js"

// For JSDoc autocompletion
import { DataTextureSceneModelNode } from "../../DataTextureSceneModelNode.js"
import { Scene } from "../../../../../scene/Scene.js"

/**
 * Wheter the FPS tracker was already installed.
 */
let _attachedFPSTracker = false;

/**
 * The list of ````LodCullingManager````'s subscribed to FPS tracking.
 * 
 * @type {Array <LodCullingManager>}
 */
const _fpsTrackingManagers = [];

/**
 * 
 * @param {Scene} scene 
 * @param {LodCullingManager} cullingManager
 */
function attachFPSTracker (scene, cullingManager) {   
    if (!_attachedFPSTracker) {
        _attachedFPSTracker = true;

        const MAX_NUM_TICKS = 4;
        let tickTimeArray = new Array (MAX_NUM_TICKS);
        let numTick = 0;

        let currentFPS = -1;

        let preRenderTime = Date.now();
        let deltaTime = 0;

        // Apply LOD-culling before rendering the scene
        scene.on("rendering", function () {
            if (currentFPS == -1)
            {
                return;
            }

            // Call LOD-culling tasks
            for (let i = 0, len = _fpsTrackingManagers.length; i < len; i++)
            {
                _fpsTrackingManagers[i].applyLodCulling (currentFPS);
            }
        });

        // Once the scene has dispached the GL draw* commands, the rendering will
        // happen in asynchornous mode.

        // A way to measure the frame-rate, is the time that passes:
        // - since all render commands are sent to the GPU
        //   (the "scene.rendered" event)
        // - until the next animation-frame callback is called
        //   (when the callback passed to "requestAnimationFrame" is called)

        // One advantqage of this method is that the frame-rate tracking will
        // track mostly the GPU-time: if traditional mechanisms based on xeokit events
        // were used instead, the frame-rate counter would also measure possibly
        // the user-side code during dispatching of events.

        // This mechanism here is not ideal but at least makes sure to track the
        // frame-rate in such a way that is directly proportional to the time spent
        // drawing geometry on the GPU. And this makes the metric quite good for the
        // prupose of the LOD mechanism!
        scene.on("rendered", function () {
            preRenderTime = Date.now ();

            window.requestAnimationFrame(function () {
                numTick++;

                const newTime = Date.now();
                deltaTime = newTime - preRenderTime;
    
                preRenderTime = newTime;
    
                tickTimeArray[numTick % MAX_NUM_TICKS] = deltaTime;
    
                let sumTickTimes = 0;
    
                if (numTick > MAX_NUM_TICKS)
                {
                    for (let i = 0; i < MAX_NUM_TICKS; i++)
                    {
                        sumTickTimes += tickTimeArray[i];
                    }
            
                    currentFPS = MAX_NUM_TICKS / sumTickTimes * 1000;
                }    
            });
        });

        // If the camera stays quiet for more than 3 scene ticks, completely
        // reset the LOD culling mechanism
        {
            let sceneTick = 0;

            let lastTickCameraMoved = sceneTick ;

            scene.camera.on ("matrix", function () {
                lastTickCameraMoved = sceneTick ;
            });

            scene.on ("tick", function () {
                if ((sceneTick  - lastTickCameraMoved) > 3)
                {
                    // Call LOD-culling tasks
                    for (let i = 0, len = _fpsTrackingManagers.length; i < len; i++)
                    {
                        _fpsTrackingManagers[i].resetLodCulling ();
                    }
                }

                sceneTick++;
            });
        }
    }

    _fpsTrackingManagers.push (cullingManager);
}

/**
 * Data structure containing pre-initialized `LOD` data.
 * 
 * Will be used by the rest of `LOD` related code.
 */
 class LodState {
    /**
     * @param {Array<number>} lodLevels The triangle counts for the LOD levels, for example ```[ 2000, 600, 150, 80, 20 ]```
     * @param {number} targetFps The target FPS (_Frames Per Second_) for the dynamic culling of objects in the different LOD levels.
     */
    constructor (lodLevels, targetFps) {
        /**
         * An array ordered DESC with the number of triangles allowed in each LOD bucket.
         * 
         * @type {Array<number>}
         */
        this.triangleLODLevels = lodLevels;

        /**
         * A computed dictionary for `triangle-number-buckets` where:
         * - key: the number of triangles allowed for the objects in the bucket.
         * - value: all PerformanceNodes that have the number of triangles or more.
         * 
         * @type {Map<number, Array<DataTextureSceneModelNode>>}
         */
        this.nodesInLOD = {};

        /**
         * A computed dictionary for `triangle-number-buckets` where:
         * - key: the number of triangles allowed for the objects in the bucket.
         * - value: the sum of triangles counts for all PeformanceNodes in the bucket.
         * 
         * @type {Map<number, number>}
         */
        this.triangleCountInLOD = {};

        /**
         * The target FPS for the `LOD` mechanism:
         * - if real FPS are below this number, the next `LOD` level will be applied.
         * 
         * - if real FPS are...
         *   - above this number plus a margin
         *   - and for some consecutive frames
         *  ... then the previous `LOD` level will be applied.
         * 
         * @type {number}
         */
        this.targetFps = targetFps;

        // /**
        //  * Not used at the moment.
        //  */
        // this.restoreTime = LOD_RESTORE_TIME;

        /**
         * Current `LOD` level. Starts at 0.
         * 
         * @type {number}
         */
        this.lodLevelIndex = 0;

        /**
         * Number of consecutive frames in current `LOD` level where FPS was above `targetFps`
         * 
         * @type {number}
         */
        this.consecutiveFramesWithTargetFps = 0;

        /**
         * Number of consecutive frames in current `LOD` level where FPS was below `targetFps`
         * 
         * @type {number}
         */
        this.consecutiveFramesWithoutTargetFps = 0;
    }

    /**
     * @param {DataTextureSceneModel} model
     */
    initializeLodState (model) {
        if (model._nodeList.length == 0)
        {
            return;
        }

        //      const LOD_LEVELS = [ 2000, 600, 150, 80, 20 ];
        //      const LOD_RESTORE_TIME = 600;
        //      const LOD_TARGET_FPS = 20;
        const nodeList = model._nodeList;
        
        let nodesInLOD = {};
        let triangleCountInLOD = {};

        for (let i = 0, len = nodeList.length; i < len; i++)
        {
            const node = nodeList[i];

            let lodLevel, len;

            for (lodLevel = 0, len = this.triangleLODLevels.length; lodLevel < len; lodLevel++)
            {
                if (node.numTriangles >= this.triangleLODLevels [lodLevel])
                {
                    break;
                }
            }

            var lodPolys = this.triangleLODLevels [lodLevel] || 0;

            if (!(lodPolys in nodesInLOD))
            {
                nodesInLOD [lodPolys] = [];
            }

            nodesInLOD [lodPolys].push (node);

            if (!(lodPolys in triangleCountInLOD))
            {
                triangleCountInLOD [lodPolys] = 0;
            }

            triangleCountInLOD [lodPolys] += node.numTriangles;
        }

        this.nodesInLOD = nodesInLOD;
        this.triangleCountInLOD = triangleCountInLOD;
    }
}

class LodCullingManager {
    /**
     * @param {DataTextureSceneModel} model
     * @param {Array<number>} lodLevels 
     * @param {number} targetFps 
     */
    constructor (model, lodLevels, targetFps) {
        /**
         * @type {DataTextureSceneModel}
         */
        this.model = model;

        /**
         * @private
         */
        this.lodState = new LodState (
            lodLevels,
            targetFps
        );

        console.time ("initializeLodState");
        
        this.lodState.initializeLodState (model);
        
        console.timeEnd ("initializeLodState");

        attachFPSTracker (this.model.scene, this);
    }

    /** 
     * Cull any objects belonging to the current `LOD` level, and increase the `LOD` level.
     * 
     * @private
     */
    _increaseLODLevelIndex ()
    {
        const lodState = this.lodState;

        if (lodState.lodLevelIndex == lodState.triangleLODLevels.length)
        {
            return false;
        }

        const nodesInLOD = lodState.nodesInLOD [lodState.triangleLODLevels[lodState.lodLevelIndex]] || [];

        for (let i = 0, len = nodesInLOD.length; i < len; i++)
        {
            nodesInLOD[i].culledLOD = true;
        }

        lodState.lodLevelIndex++;

        return true;
    }

    /** 
     * Un-cull any objects belonging to the current `LOD` level, and decrease the `LOD` level.
     * 
     * @private
     */
    _decreaseLODLevelIndex ()
    {
        const lodState = this.lodState;

        if (lodState.lodLevelIndex == 0)
        {
            return false;
        }

        const nodesInLOD = lodState.nodesInLOD [lodState.triangleLODLevels[lodState.lodLevelIndex - 1]] || [];

        for (let i = 0, len = nodesInLOD.length; i < len; i++)
        {
            nodesInLOD[i].culledLOD = false;
        }

        lodState.lodLevelIndex--;

        return true;
    }

    /**
     * Apply LOD culling.
     * 
     * Will update LOD level, if needed, based in...
     * - current FPS
     * - target FPS
     * 
     * ... and then will cull/uncull the needed objects according to the LOD level.
     * 
     * @param {number} currentFPS The current FPS (frames per second)
     * @returns {boolean} Whether the LOD level was changed. This is, if some object was culled/unculled
     */
    applyLodCulling (currentFPS)
    {
        let lodState = this.lodState;
        const model = this.model;
        
        let retVal = false;

        if (currentFPS < lodState.targetFps)
        {
            if (++lodState.consecutiveFramesWithoutTargetFps > 0)
            {
                lodState.consecutiveFramesWithoutTargetFps = 0;
                retVal = this._increaseLODLevelIndex();
            }
        }
        else if (currentFPS > (lodState.targetFps + 4))
        {
            if (++lodState.consecutiveFramesWithTargetFps > 1)
            {
                lodState.consecutiveFramesWithTargetFps = 0;
                retVal = this._decreaseLODLevelIndex();
            }
        }

        if (retVal) {
            console.log ("LOD level = " + lodState.lodLevelIndex);
        }

        return retVal;
    }

    resetLodCulling ()
    {
        const model = this.model;
        
        let retVal = false;

        let decreasedLevel = false;

        do {
            retVal |= (decreasedLevel = this._decreaseLODLevelIndex());
        } while (decreasedLevel);

        if (retVal) {
            console.log ("LOD resetted");
        }

        return retVal;
    }
}

export { LodCullingManager }