import { EventHandler } from '../../core/event-handler.js';

/** @typedef {import('./system.js').ComponentSystem} ComponentSystem */
/** @typedef {import('../entity.js').Entity} Entity */

/**
 * Components are used to attach functionality on a {@link Entity}. Components can receive update
 * events each frame, and expose properties to the PlayCanvas Editor.
 *
 * @property {ComponentSystem} system The ComponentSystem used to create this Component.
 * @property {Entity} entity The Entity that this Component is attached to.
 * @property {boolean} enabled Enables or disables the component.
 * @augments EventHandler
 */
class Component extends EventHandler {
    /**
     * Base constructor for a Component.
     *
     * @param {ComponentSystem} system - The ComponentSystem used to create this Component.
     * @param {Entity} entity - The Entity that this Component is attached to.
     */
    constructor(system, entity) {
        super();

        this.system = system;
        this.entity = entity;

        if (this.system.schema && !this._accessorsBuilt) {
            this.buildAccessors(this.system.schema);
        }

        this.on("set", function (name, oldValue, newValue) {
            this.fire("set_" + name, name, oldValue, newValue);
        });

        this.on('set_enabled', this.onSetEnabled, this);
    }

    static _buildAccessors(obj, schema) {
        // Create getter/setter pairs for each property defined in the schema
        schema.forEach(function (descriptor) {
            // If the property descriptor is an object, it should have a `name`
            // member. If not, it should just be the plain property name.
            const name = (typeof descriptor === 'object') ? descriptor.name : descriptor;

            Object.defineProperty(obj, name, {
                get: function () {
                    return this.data[name];
                },
                set: function (value) {
                    const data = this.data;
                    const oldValue = data[name];
                    data[name] = value;
                    this.fire('set', name, oldValue, value);
                },
                configurable: true
            });
        });

        obj._accessorsBuilt = true;
    }

    buildAccessors(schema) {
        Component._buildAccessors(this, schema);
    }

    onSetEnabled(name, oldValue, newValue) {
        if (oldValue !== newValue) {
            if (this.entity.enabled) {
                if (newValue) {
                    this.onEnable();
                } else {
                    this.onDisable();
                }
            }
        }
    }

    onEnable() {
    }

    onDisable() {
    }

    onPostStateChange() {
    }

    /**
     * @private
     * @name Component#data
     * @type {ComponentData}
     * @description Access the component data directly.
     * Usually you should access the data properties via the individual properties as
     * modifying this data directly will not fire 'set' events.
     */
    get data() {
        const record = this.system.store[this.entity.getGuid()];
        return record ? record.data : null;
    }
}

export { Component };
