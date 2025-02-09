import { Debug } from '../../../core/debug.js';
import {
    LAYERID_WORLD
} from '../../../scene/constants.js';
import { BatchGroup } from '../../../scene/batching/batch-group.js';
import { GraphNode } from '../../../scene/graph-node.js';
import { MeshInstance } from '../../../scene/mesh-instance.js';
import { Model } from '../../../scene/model.js';
import { getShapePrimitive } from '../../../scene/procedural.js';

import { Asset } from '../../../asset/asset.js';

import { Component } from '../component.js';

/** @typedef {import('../../../shape/bounding-box.js').BoundingBox} BoundingBox */
/** @typedef {import('../../entity.js').Entity} Entity */
/** @typedef {import('./system.js').ModelComponentSystem} ModelComponentSystem */

/**
 * Enables an Entity to render a model or a primitive shape. This Component attaches additional
 * model geometry in to the scene graph below the Entity.
 *
 * @augments Component
 */
class ModelComponent extends Component {
    /**
     * Create a new ModelComponent instance.
     *
     * @param {ModelComponentSystem} system - The ComponentSystem that created this Component.
     * @param {Entity} entity - The Entity that this Component is attached to.
     */
    constructor(system, entity) {
        super(system, entity);

        this._type = 'asset';

        /**
         * @type {number}
         * @private
         */
        this._asset = null;
        /**
         * @type {Model}
         * @private
         */
        this._model = null;

        this._mapping = {};

        this._castShadows = true;
        this._receiveShadows = true;

        /**
         * @type {Asset}
         * @private
         */
        this._materialAsset = null;
        this._material = system.defaultMaterial;

        this._castShadowsLightmap = true;
        this._lightmapped = false;
        this._lightmapSizeMultiplier = 1;
        this._isStatic = false;

        this._layers = [LAYERID_WORLD]; // assign to the default world layer
        this._batchGroupId = -1;

        /**
         * @type {BoundingBox}
         * @private
         */
        this._customAabb = null;

        this._area = null;

        this._assetOld = 0;
        this._materialEvents = null;
        this._dirtyModelAsset = false;
        this._dirtyMaterialAsset = false;

        this._clonedModel = false;

        // #if _DEBUG
        this._batchGroup = null;
        // #endif

        // handle events when the entity is directly (or indirectly as a child of sub-hierarchy) added or removed from the parent
        entity.on('remove', this.onRemoveChild, this);
        entity.on('removehierarchy', this.onRemoveChild, this);
        entity.on('insert', this.onInsertChild, this);
        entity.on('inserthierarchy', this.onInsertChild, this);
    }

    /**
     * An array of meshInstances contained in the component's model. If model is not set or loaded
     * for component it will return null.
     *
     * @type {MeshInstance[]}
     */
    set meshInstances(value) {
        if (!this._model)
            return;

        this._model.meshInstances = value;
    }

    get meshInstances() {
        if (!this._model)
            return null;

        return this._model.meshInstances;
    }

    /**
     * If set, the object space bounding box is used as a bounding box for visibility culling of
     * attached mesh instances. This is an optimization, allowing oversized bounding box to be
     * specified for skinned characters in order to avoid per frame bounding box computations based
     * on bone positions.
     *
     * @type {BoundingBox}
     */
    set customAabb(value) {
        this._customAabb = value;

        // set it on meshInstances
        if (this._model) {
            const mi = this._model.meshInstances;
            if (mi) {
                for (let i = 0; i < mi.length; i++) {
                    mi[i].setCustomAabb(this._customAabb);
                }
            }
        }
    }

    get customAabb() {
        return this._customAabb;
    }

    /**
     * The type of the model. Can be:
     *
     * - "asset": The component will render a model asset
     * - "box": The component will render a box (1 unit in each dimension)
     * - "capsule": The component will render a capsule (radius 0.5, height 2)
     * - "cone": The component will render a cone (radius 0.5, height 1)
     * - "cylinder": The component will render a cylinder (radius 0.5, height 1)
     * - "plane": The component will render a plane (1 unit in each dimension)
     * - "sphere": The component will render a sphere (radius 0.5)
     *
     * @type {string}
     */
    set type(value) {
        if (this._type === value) return;

        this._area = null;

        this._type = value;

        if (value === 'asset') {
            if (this._asset !== null) {
                this._bindModelAsset(this._asset);
            } else {
                this.model = null;
            }
        } else {

            // get / create mesh of type
            const primData = getShapePrimitive(this.system.app.graphicsDevice, value);
            this._area = primData.area;
            const mesh = primData.mesh;

            const node = new GraphNode();
            const model = new Model();
            model.graph = node;

            model.meshInstances = [new MeshInstance(mesh, this._material, node)];

            this.model = model;
            this._asset = null;
        }
    }

    get type() {
        return this._type;
    }

    /**
     * The asset for the model (only applies to models of type 'asset') can also be an asset id.
     *
     * @type {Asset|number}
     */
    set asset(value) {
        const assets = this.system.app.assets;
        let _id = value;

        if (value instanceof Asset) {
            _id = value.id;
        }

        if (this._asset !== _id) {
            if (this._asset) {
                // remove previous asset
                assets.off('add:' + this._asset, this._onModelAssetAdded, this);
                const _prev = assets.get(this._asset);
                if (_prev) {
                    this._unbindModelAsset(_prev);
                }
            }

            this._asset = _id;

            if (this._asset) {
                const asset = assets.get(this._asset);
                if (!asset) {
                    this.model = null;
                    assets.on('add:' + this._asset, this._onModelAssetAdded, this);
                } else {
                    this._bindModelAsset(asset);
                }
            } else {
                this.model = null;
            }
        }
    }

    get asset() {
        return this._asset;
    }

    /**
     * The model that is added to the scene graph. It can be not set or loaded, so will return null.
     *
     * @type {Model}
     */
    set model(value) {
        if (this._model === value)
            return;

        // return if the model has been flagged as immutable
        if (value && value._immutable) {
            Debug.error('Invalid attempt to assign a model to multiple ModelComponents');
            return;
        }

        if (this._model) {
            this._model._immutable = false;

            this.removeModelFromLayers();
            this.entity.removeChild(this._model.getGraph());
            delete this._model._entity;

            if (this._clonedModel) {
                this._model.destroy();
                this._clonedModel = false;
            }
        }

        this._model = value;

        if (this._model) {
            // flag the model as being assigned to a component
            this._model._immutable = true;

            const meshInstances = this._model.meshInstances;

            for (let i = 0; i < meshInstances.length; i++) {
                meshInstances[i].castShadow = this._castShadows;
                meshInstances[i].receiveShadow = this._receiveShadows;
                meshInstances[i].isStatic = this._isStatic;
                meshInstances[i].setCustomAabb(this._customAabb);
            }

            this.lightmapped = this._lightmapped; // update meshInstances

            this.entity.addChild(this._model.graph);

            if (this.enabled && this.entity.enabled) {
                this.addModelToLayers();
            }

            // Store the entity that owns this model
            this._model._entity = this.entity;

            // Update any animation component
            if (this.entity.animation)
                this.entity.animation.setModel(this._model);

            // Update any animation component
            if (this.entity.anim) {
                if (this.entity.anim.playing) {
                    this.entity.anim.rebind();
                } else {
                    this.entity.anim.resetStateGraph();
                }
            }
            // trigger event handler to load mapping
            // for new model
            if (this.type === 'asset') {
                this.mapping = this._mapping;
            } else {
                this._unsetMaterialEvents();
            }
        }
    }

    get model() {
        return this._model;
    }

    /**
     * If true, this model will be lightmapped after using lightmapper.bake().
     *
     * @type {boolean}
     */
    set lightmapped(value) {
        if (value !== this._lightmapped) {

            this._lightmapped = value;

            if (this._model) {
                const mi = this._model.meshInstances;
                for (let i = 0; i < mi.length; i++) {
                    mi[i].setLightmapped(value);
                }
            }
        }
    }

    get lightmapped() {
        return this._lightmapped;
    }

    /**
     * If true, this model will cast shadows for lights that have shadow casting enabled.
     *
     * @type {boolean}
     */
    set castShadows(value) {
        if (this._castShadows === value) return;

        const model = this._model;

        if (model) {
            const layers = this.layers;
            const scene = this.system.app.scene;
            if (this._castShadows && !value) {
                for (let i = 0; i < layers.length; i++) {
                    const layer = this.system.app.scene.layers.getLayerById(this.layers[i]);
                    if (!layer) continue;
                    layer.removeShadowCasters(model.meshInstances);
                }
            }

            const meshInstances = model.meshInstances;
            for (let i = 0; i < meshInstances.length; i++) {
                meshInstances[i].castShadow = value;
            }

            if (!this._castShadows && value) {
                for (let i = 0; i < layers.length; i++) {
                    const layer = scene.layers.getLayerById(layers[i]);
                    if (!layer) continue;
                    layer.addShadowCasters(model.meshInstances);
                }
            }
        }

        this._castShadows = value;
    }

    get castShadows() {
        return this._castShadows;
    }

    /**
     * If true, shadows will be cast on this model.
     *
     * @type {boolean}
     */
    set receiveShadows(value) {
        if (this._receiveShadows === value) return;

        this._receiveShadows = value;

        if (this._model) {
            const meshInstances = this._model.meshInstances;
            for (let i = 0, len = meshInstances.length; i < len; i++) {
                meshInstances[i].receiveShadow = value;
            }
        }
    }

    get receiveShadows() {
        return this._receiveShadows;
    }

    /**
     * If true, this model will cast shadows when rendering lightmaps.
     *
     * @type {boolean}
     */
    set castShadowsLightmap(value) {
        this._castShadowsLightmap = value;
    }

    get castShadowsLightmap() {
        return this._castShadowsLightmap;
    }

    /**
     * Lightmap resolution multiplier.
     *
     * @type {number}
     */
    set lightmapSizeMultiplier(value) {
        this._lightmapSizeMultiplier = value;
    }

    get lightmapSizeMultiplier() {
        return this._lightmapSizeMultiplier;
    }

    /**
     * Mark model as non-movable (optimization).
     *
     * @type {boolean}
     */
    set isStatic(value) {
        if (this._isStatic === value) return;

        this._isStatic = value;

        if (this._model) {
            const rcv = this._model.meshInstances;
            for (let i = 0; i < rcv.length; i++) {
                const m = rcv[i];
                m.isStatic = value;
            }
        }
    }

    get isStatic() {
        return this._isStatic;
    }

    /**
     * An array of layer IDs ({@link Layer#id}) to which this model should belong. Don't push, pop,
     * splice or modify this array, if you want to change it - set a new one instead.
     *
     * @type {number[]}
     */
    set layers(value) {
        const layers = this.system.app.scene.layers;

        if (this.meshInstances) {
            // remove all mesh instances from old layers
            for (let i = 0; i < this._layers.length; i++) {
                const layer = layers.getLayerById(this._layers[i]);
                if (!layer) continue;
                layer.removeMeshInstances(this.meshInstances);
            }
        }

        // set the layer list
        this._layers.length = 0;
        for (let i = 0; i < value.length; i++) {
            this._layers[i] = value[i];
        }

        // don't add into layers until we're enabled
        if (!this.enabled || !this.entity.enabled || !this.meshInstances) return;

        // add all mesh instances to new layers
        for (let i = 0; i < this._layers.length; i++) {
            const layer = layers.getLayerById(this._layers[i]);
            if (!layer) continue;
            layer.addMeshInstances(this.meshInstances);
        }
    }

    get layers() {
        return this._layers;
    }

    /**
     * Assign model to a specific batch group (see {@link BatchGroup}). Default is -1 (no group).
     *
     * @type {number}
     */
    set batchGroupId(value) {
        if (this._batchGroupId === value) return;

        const batcher = this.system.app.batcher;
        if (this.entity.enabled && this._batchGroupId >= 0) {
            batcher.remove(BatchGroup.MODEL, this.batchGroupId, this.entity);
        }
        if (this.entity.enabled && value >= 0) {
            batcher.insert(BatchGroup.MODEL, value, this.entity);
        }

        if (value < 0 && this._batchGroupId >= 0 && this.enabled && this.entity.enabled) {
            // re-add model to scene, in case it was removed by batching
            this.addModelToLayers();
        }

        this._batchGroupId = value;
    }

    get batchGroupId() {
        return this._batchGroupId;
    }

    /**
     * The material {@link Asset} that will be used to render the model (not used on models of type
     * 'asset').
     *
     * @type {Asset|number}
     */
    set materialAsset(value) {
        let _id = value;
        if (value instanceof Asset) {
            _id = value.id;
        }

        const assets = this.system.app.assets;

        if (_id !== this._materialAsset) {
            if (this._materialAsset) {
                assets.off('add:' + this._materialAsset, this._onMaterialAssetAdd, this);
                const _prev = assets.get(this._materialAsset);
                if (_prev) {
                    this._unbindMaterialAsset(_prev);
                }
            }

            this._materialAsset = _id;

            if (this._materialAsset) {
                const asset = assets.get(this._materialAsset);
                if (!asset) {
                    this._setMaterial(this.system.defaultMaterial);
                    assets.on('add:' + this._materialAsset, this._onMaterialAssetAdd, this);
                } else {
                    this._bindMaterialAsset(asset);
                }
            } else {
                this._setMaterial(this.system.defaultMaterial);
            }
        }
    }

    get materialAsset() {
        return this._materialAsset;
    }

    /**
     * The material {@link Material} that will be used to render the model (not used on models of
     * type 'asset').
     *
     * @type {Material}
     */
    set material(value) {
        if (this._material === value)
            return;

        this.materialAsset = null;

        this._setMaterial(value);
    }

    get material() {
        return this._material;
    }

    /**
     * A dictionary that holds material overrides for each mesh instance. Only applies to model
     * components of type 'asset'. The mapping contains pairs of mesh instance index - material
     * asset id.
     *
     * @type {object}
     */
    set mapping(value) {
        if (this._type !== 'asset')
            return;

        // unsubscribe from old events
        this._unsetMaterialEvents();

        // can't have a null mapping
        if (!value)
            value = {};

        this._mapping = value;

        if (!this._model) return;

        const meshInstances = this._model.meshInstances;
        const modelAsset = this.asset ? this.system.app.assets.get(this.asset) : null;
        const assetMapping = modelAsset ? modelAsset.data.mapping : null;
        let asset = null;

        for (let i = 0, len = meshInstances.length; i < len; i++) {
            if (value[i] !== undefined) {
                if (value[i]) {
                    asset = this.system.app.assets.get(value[i]);
                    this._loadAndSetMeshInstanceMaterial(asset, meshInstances[i], i);
                } else {
                    meshInstances[i].material = this.system.defaultMaterial;
                }
            } else if (assetMapping) {
                if (assetMapping[i] && (assetMapping[i].material || assetMapping[i].path)) {
                    if (assetMapping[i].material !== undefined) {
                        asset = this.system.app.assets.get(assetMapping[i].material);
                    } else if (assetMapping[i].path !== undefined) {
                        const url = this._getMaterialAssetUrl(assetMapping[i].path);
                        if (url) {
                            asset = this.system.app.assets.getByUrl(url);
                        }
                    }
                    this._loadAndSetMeshInstanceMaterial(asset, meshInstances[i], i);
                } else {
                    meshInstances[i].material = this.system.defaultMaterial;
                }
            }
        }
    }

    get mapping() {
        return this._mapping;
    }

    addModelToLayers() {
        const layers = this.system.app.scene.layers;
        for (let i = 0; i < this._layers.length; i++) {
            const layer = layers.getLayerById(this._layers[i]);
            if (layer) {
                layer.addMeshInstances(this.meshInstances);
            }
        }
    }

    removeModelFromLayers() {
        const layers = this.system.app.scene.layers;
        for (let i = 0; i < this._layers.length; i++) {
            const layer = layers.getLayerById(this._layers[i]);
            if (!layer) continue;
            layer.removeMeshInstances(this.meshInstances);
        }
    }

    onRemoveChild() {
        if (this._model)
            this.removeModelFromLayers();
    }

    onInsertChild() {
        if (this._model && this.enabled && this.entity.enabled)
            this.addModelToLayers();
    }

    onRemove() {
        this.asset = null;
        this.model = null;
        this.materialAsset = null;
        this._unsetMaterialEvents();

        this.entity.off('remove', this.onRemoveChild, this);
        this.entity.off('insert', this.onInsertChild, this);
    }

    onLayersChanged(oldComp, newComp) {
        this.addModelToLayers();
        oldComp.off("add", this.onLayerAdded, this);
        oldComp.off("remove", this.onLayerRemoved, this);
        newComp.on("add", this.onLayerAdded, this);
        newComp.on("remove", this.onLayerRemoved, this);
    }

    onLayerAdded(layer) {
        const index = this.layers.indexOf(layer.id);
        if (index < 0) return;
        layer.addMeshInstances(this.meshInstances);
    }

    onLayerRemoved(layer) {
        const index = this.layers.indexOf(layer.id);
        if (index < 0) return;
        layer.removeMeshInstances(this.meshInstances);
    }

    _setMaterialEvent(index, event, id, handler) {
        const evt = event + ':' + id;
        this.system.app.assets.on(evt, handler, this);

        if (!this._materialEvents)
            this._materialEvents = [];

        if (!this._materialEvents[index])
            this._materialEvents[index] = { };

        this._materialEvents[index][evt] = {
            id: id,
            handler: handler
        };
    }

    _unsetMaterialEvents() {
        const assets = this.system.app.assets;
        const events = this._materialEvents;
        if (!events)
            return;

        for (let i = 0, len = events.length; i < len; i++) {
            if (!events[i]) continue;
            const evt = events[i];
            for (const key in evt) {
                assets.off(key, evt[key].handler, this);
            }
        }

        this._materialEvents = null;
    }

    _getAssetByIdOrPath(idOrPath) {
        let asset = null;
        const isPath = isNaN(parseInt(idOrPath, 10));

        // get asset by id or url
        if (!isPath) {
            asset = this.system.app.assets.get(idOrPath);
        } else if (this.asset) {
            const url = this._getMaterialAssetUrl(idOrPath);
            if (url)
                asset = this.system.app.assets.getByUrl(url);
        }

        return asset;
    }

    _getMaterialAssetUrl(path) {
        if (!this.asset) return null;

        const modelAsset = this.system.app.assets.get(this.asset);

        return modelAsset ? modelAsset.getAbsoluteUrl(path) : null;
    }

    _loadAndSetMeshInstanceMaterial(materialAsset, meshInstance, index) {
        const assets = this.system.app.assets;

        if (!materialAsset)
            return;

        if (materialAsset.resource) {
            meshInstance.material = materialAsset.resource;

            this._setMaterialEvent(index, 'remove', materialAsset.id, function () {
                meshInstance.material = this.system.defaultMaterial;
            });
        } else {
            this._setMaterialEvent(index, 'load', materialAsset.id, function (asset) {
                meshInstance.material = asset.resource;

                this._setMaterialEvent(index, 'remove', materialAsset.id, function () {
                    meshInstance.material = this.system.defaultMaterial;
                });
            });

            if (this.enabled && this.entity.enabled)
                assets.load(materialAsset);
        }
    }

    onEnable() {
        const app = this.system.app;
        const scene = app.scene;

        scene.on("set:layers", this.onLayersChanged, this);
        if (scene.layers) {
            scene.layers.on("add", this.onLayerAdded, this);
            scene.layers.on("remove", this.onLayerRemoved, this);
        }

        const isAsset = (this._type === 'asset');

        let asset;
        if (this._model) {
            this.addModelToLayers();
        } else if (isAsset && this._asset) {
            // bind and load model asset if necessary
            asset = app.assets.get(this._asset);
            if (asset && asset.resource !== this._model) {
                this._bindModelAsset(asset);
            }
        }

        if (this._materialAsset) {
            // bind and load material asset if necessary
            asset = app.assets.get(this._materialAsset);
            if (asset && asset.resource !== this._material) {
                this._bindMaterialAsset(asset);
            }
        }

        if (isAsset) {
            // bind mapped assets
            // TODO: replace
            if (this._mapping) {
                for (const index in this._mapping) {
                    if (this._mapping[index]) {
                        asset = this._getAssetByIdOrPath(this._mapping[index]);
                        if (asset && !asset.resource) {
                            app.assets.load(asset);
                        }
                    }
                }
            }
        }

        if (this._batchGroupId >= 0) {
            app.batcher.insert(BatchGroup.MODEL, this.batchGroupId, this.entity);
        }
    }

    onDisable() {
        const app = this.system.app;
        const scene = app.scene;

        scene.off("set:layers", this.onLayersChanged, this);
        if (scene.layers) {
            scene.layers.off("add", this.onLayerAdded, this);
            scene.layers.off("remove", this.onLayerRemoved, this);
        }

        if (this._batchGroupId >= 0) {
            app.batcher.remove(BatchGroup.MODEL, this.batchGroupId, this.entity);
        }

        if (this._model) {
            this.removeModelFromLayers();
        }
    }

    /**
     * Stop rendering model without removing it from the scene hierarchy. This method sets the
     * {@link MeshInstance#visible} property of every MeshInstance in the model to false Note, this
     * does not remove the model or mesh instances from the scene hierarchy or draw call list. So
     * the model component still incurs some CPU overhead.
     *
     * @example
     * this.timer = 0;
     * this.visible = true;
     * // ...
     * // blink model every 0.1 seconds
     * this.timer += dt;
     * if (this.timer > 0.1) {
     *     if (!this.visible) {
     *         this.entity.model.show();
     *         this.visible = true;
     *     } else {
     *         this.entity.model.hide();
     *         this.visible = false;
     *     }
     *     this.timer = 0;
     * }
     */
    hide() {
        if (this._model) {
            const instances = this._model.meshInstances;
            for (let i = 0, l = instances.length; i < l; i++) {
                instances[i].visible = false;
            }
        }
    }

    /**
     * Enable rendering of the model if hidden using {@link ModelComponent#hide}. This method sets
     * all the {@link MeshInstance#visible} property on all mesh instances to true.
     */
    show() {
        if (this._model) {
            const instances = this._model.meshInstances;
            for (let i = 0, l = instances.length; i < l; i++) {
                instances[i].visible = true;
            }
        }
    }

    _bindMaterialAsset(asset) {
        asset.on('load', this._onMaterialAssetLoad, this);
        asset.on('unload', this._onMaterialAssetUnload, this);
        asset.on('remove', this._onMaterialAssetRemove, this);
        asset.on('change', this._onMaterialAssetChange, this);

        if (asset.resource) {
            this._onMaterialAssetLoad(asset);
        } else {
            // don't trigger an asset load unless the component is enabled
            if (!this.enabled || !this.entity.enabled) return;
            this.system.app.assets.load(asset);
        }
    }

    _unbindMaterialAsset(asset) {
        asset.off('load', this._onMaterialAssetLoad, this);
        asset.off('unload', this._onMaterialAssetUnload, this);
        asset.off('remove', this._onMaterialAssetRemove, this);
        asset.off('change', this._onMaterialAssetChange, this);
    }

    _onMaterialAssetAdd(asset) {
        this.system.app.assets.off('add:' + asset.id, this._onMaterialAssetAdd, this);
        if (this._materialAsset === asset.id) {
            this._bindMaterialAsset(asset);
        }
    }

    _onMaterialAssetLoad(asset) {
        this._setMaterial(asset.resource);
    }

    _onMaterialAssetUnload(asset) {
        this._setMaterial(this.system.defaultMaterial);
    }

    _onMaterialAssetRemove(asset) {
        this._onMaterialAssetUnload(asset);
    }

    _onMaterialAssetChange(asset) {
    }

    _bindModelAsset(asset) {
        this._unbindModelAsset(asset);

        asset.on('load', this._onModelAssetLoad, this);
        asset.on('unload', this._onModelAssetUnload, this);
        asset.on('change', this._onModelAssetChange, this);
        asset.on('remove', this._onModelAssetRemove, this);

        if (asset.resource) {
            this._onModelAssetLoad(asset);
        } else {
            // don't trigger an asset load unless the component is enabled
            if (!this.enabled || !this.entity.enabled) return;

            this.system.app.assets.load(asset);
        }
    }

    _unbindModelAsset(asset) {
        asset.off('load', this._onModelAssetLoad, this);
        asset.off('unload', this._onModelAssetUnload, this);
        asset.off('change', this._onModelAssetChange, this);
        asset.off('remove', this._onModelAssetRemove, this);
    }

    _onModelAssetAdded(asset) {
        this.system.app.assets.off('add:' + asset.id, this._onModelAssetAdded, this);
        if (asset.id === this._asset) {
            this._bindModelAsset(asset);
        }
    }

    _onModelAssetLoad(asset) {
        this.model = asset.resource.clone();
        this._clonedModel = true;
    }

    _onModelAssetUnload(asset) {
        this.model = null;
    }

    _onModelAssetChange(asset, attr, _new, _old) {
        if (attr === 'data') {
            this.mapping = this._mapping;
        }
    }

    _onModelAssetRemove(asset) {
        this.model = null;
    }

    _setMaterial(material) {
        if (this._material === material)
            return;

        this._material = material;

        const model = this._model;
        if (model && this._type !== 'asset') {
            const meshInstances = model.meshInstances;
            for (let i = 0, len = meshInstances.length; i < len; i++) {
                meshInstances[i].material = material;
            }
        }
    }
}

export { ModelComponent };
