import { ComponentLike, Cover, Device, Switch, Light } from '@lucavb/shellies-ds9';
import { PlatformAccessory } from 'homebridge';

import {
    Ability,
    AccessoryInformationAbility,
    BatteryAbility,
    ContactSensorAbility,
    CoverAbility,
    GarageDoorOpenerAbility,
    HumiditySensorAbility,
    LightAbility,
    OutletAbility,
    PowerMeterAbility,
    SwitchAbility,
    TemperatureSensorAbility,
    VoltmeterAbility,
} from '../abilities/index.ts';
import { Accessory, AccessoryId } from '../accessory.ts';
import { DeviceLogger } from '../utils/device-logger.ts';
import { CoverOptions, DeviceOptions, SwitchOptions, LightOptions } from '../config.ts';
import { ShellyPlatform } from '../platform.ts';

type DiscoverableComponent = ComponentLike & {
    id: number;
    key: string;
    on(event: string, handler: unknown, context: unknown): unknown;
    off(event: string, handler: unknown, context: unknown): unknown;
    [key: string]: unknown;
};
type RpcAddonComponent = DiscoverableComponent;

type RpcBluetoothComponent = DiscoverableComponent;
type RefreshableAddonAbility = Ability & {
    refresh(): void;
};

type RefreshableBluetoothAbility = Ability & {
    refresh(): void;
};
type ShellyStatusComponent = Record<string, unknown> & {
    id?: unknown;
};
type ShellyStatus = Record<string, ShellyStatusComponent | unknown>;

type ShellyComponentsEntry = {
    key?: unknown;
    status?: Record<string, unknown>;
    config?: Record<string, unknown>;
};

type ShellyComponentsResponse = {
    components?: ShellyComponentsEntry[];
};

/**
 * Describes a device delegate class.
 */
export interface DeviceDelegateClass {
    new (device: Device, options: DeviceOptions, platform: ShellyPlatform): DeviceDelegate;
}

/**
 * Describes a device class.
 */
export interface DeviceClass {
    model: string;
}

export interface AddSwitchOptions {
    /**
     * Whether the accessory should be active.
     */
    active: boolean;
    /**
     * Whether the device has a single switch.
     */
    single: boolean;
}

export interface AddCoverOptions {
    /**
     * Whether the accessory should be active.
     */
    active: boolean;
    /**
     * Whether the device has a single cover.
     */
    single: boolean;
}

export interface AddLightOptions {
    /**
     * Whether the accessory should be active.
     */
    active: boolean;
    /**
     * Whether the device has a single light.
     */
    single: boolean;
}

/**
 * A DeviceDelegate manages accessories for a device.
 */
export abstract class DeviceDelegate {
    /**
     * Holds all registered delegates.
     */
    private static readonly delegates: Map<string, DeviceDelegateClass> = new Map();

    /**
     * Registers a device delegate, so that it can later be found based on a device class or model
     * using the `DeviceDelegate.getDelegate()` method.
     * @param delegate - A subclass of `DeviceDelegate`.
     * @param deviceClasses - One or more subclasses of `Device`.
     */
    static registerDelegate(delegate: DeviceDelegateClass, ...deviceClasses: DeviceClass[]) {
        for (const deviceCls of deviceClasses) {
            const mdl = deviceCls.model.toUpperCase();

            // make sure it's not already registered
            if (DeviceDelegate.delegates.has(mdl)) {
                throw new Error(`A device delegate for ${deviceCls.model} has already been registered`);
            }

            // add it to the list
            DeviceDelegate.delegates.set(mdl, delegate);
        }
    }

    /**
     * Returns the device delegate for the given device class or model, if one has been registered.
     * @param deviceClsOrModel - The device class or model ID to lookup.
     */
    static getDelegate(deviceClsOrModel: DeviceClass | string): DeviceDelegateClass | undefined {
        const mdl = typeof deviceClsOrModel === 'string' ? deviceClsOrModel : deviceClsOrModel.model;
        return DeviceDelegate.delegates.get(mdl.toUpperCase());
    }

    /**
     * Holds all accessories for this device.
     */
    protected readonly accessories: Map<AccessoryId, Accessory> = new Map();

    /**
     * Logger specific for this device.
     */
    readonly log: DeviceLogger;

    /**
     * Used to keep track of whether a connection had been established when the 'disconnect' event is emitted by our RPC handler.
     */
    protected connected: boolean;

    /**
     * Lightweight RPC-backed add-on components keyed by Shelly component key.
     */
    protected readonly rpcAddonComponents: Map<string, RpcAddonComponent> = new Map();

    /**
     * Refreshable abilities keyed by Shelly RPC add-on component key.
     */
    protected readonly rpcAddonAbilities: Map<string, RefreshableAddonAbility[]> = new Map();

    /**
     * Polling timer for RPC-backed add-on components.
     */
    protected addonPollingInterval: ReturnType<typeof setInterval> | null = null;

    /**
     * Lightweight RPC-backed Bluetooth/BTHome components keyed by Shelly component key.
     */
    protected readonly rpcBluetoothComponents: Map<string, RpcBluetoothComponent> = new Map();

    /**
     * Refreshable abilities keyed by Shelly RPC Bluetooth/BTHome component key.
     */
    protected readonly rpcBluetoothAbilities: Map<string, RefreshableBluetoothAbility[]> = new Map();

    /**
     * Polling timer for RPC-backed Bluetooth/BTHome components.
     */
    protected bluetoothPollingInterval: ReturnType<typeof setInterval> | null = null;

    /**
     * @param device - The device to handle.
     * @param options - Configuration options for the device.
     * @param platform - A reference to the homebridge platform.
     */
    constructor(
        readonly device: Device,
        readonly options: DeviceOptions,
        readonly platform: ShellyPlatform,
    ) {
        this.log = new DeviceLogger(device, options.name, platform.log);
        this.log.info('Device added');

        this.log.debug(device.rpcHandler.connected ? 'Device is connected' : 'Device is disconnected');

        this.connected = device.rpcHandler.connected;

        device.rpcHandler
            .on('connect', this.handleConnect, this)
            .on('disconnect', this.handleDisconnect, this)
            .on('request', this.handleRequest, this);

        this.setup();
        void this.addAddonSensors();
        void this.addBluetoothSensors();
    }

    /**
     * Subclasses should override this method to setup the device delegate and create their
     * accessories.
     */
    protected abstract setup();

    /**
     * Retrieves configuration options for the given component from the device options.
     * @param component - The component.
     * @returns A set of options, if found.
     */
    protected getComponentOptions<T>(component: ComponentLike): T | undefined {
        return this.options?.[component.key] as T;
    }

    /**
     * Creates an accessory with the given ID.
     * If a matching platform accessory is not found in cache, a new one will be created.
     * @param id - A unique identifier for this accessory.
     * @param nameSuffix - A string to append to the name of this accessory.
     * @param abilities - The abilities to add to this accessory.
     */
    protected createAccessory(id: AccessoryId, nameSuffix: string | null, ...abilities: Ability[]): Accessory {
        // make sure the given ID is unique
        if (this.accessories.has(id)) {
            throw new Error(`An accessory with ID '${id}' already exists`);
        }

        let name = this.options.name || this.device.modelName;
        if (nameSuffix) {
            name += ' ' + nameSuffix;
        }

        // create an accessory
        const accessory = new Accessory(
            id,
            this.device.id,
            name,
            this.platform,
            this.log,
            new AccessoryInformationAbility(this.device),
            ...abilities,
        );

        // store the accessory
        this.accessories.set(id, accessory);

        return accessory;
    }

    /**
     * Creates an accessory for a switch component.
     * @param swtch - The switch component to use.
     * @param opts - Options for the switch.
     */
    protected addSwitch(swtch: Switch, opts?: Partial<AddSwitchOptions>): Accessory {
        const o = opts ?? {};

        // get the config options for this switch
        const switchOpts = this.getComponentOptions<SwitchOptions>(swtch) ?? {};

        // determine the switch type
        const type = typeof switchOpts.type === 'string' ? switchOpts.type.toLowerCase() : 'switch';
        const isOutlet = type === 'outlet';
        const isGarageDoorOpener = type === 'garagedooropener';
        const pulseDuration = typeof switchOpts.pulseDuration === 'number' ? switchOpts.pulseDuration : 0.5;

        const id = o.single === true ? 'switch' : `switch-${swtch.id}`;
        const nameSuffix = o.single === true ? null : `Switch ${swtch.id + 1}`;

        return this.createAccessory(
            id,
            nameSuffix,
            new OutletAbility(swtch).setActive(isOutlet),
            new GarageDoorOpenerAbility(swtch, pulseDuration).setActive(isGarageDoorOpener),
            new SwitchAbility(swtch).setActive(!isOutlet && !isGarageDoorOpener),
            // use the apower property to determine whether power metering is available
            new PowerMeterAbility(swtch).setActive(swtch.apower !== undefined),
        ).setActive(switchOpts.exclude !== true && o.active !== false);
    }

    /**
     * Creates an accessory for a cover component.
     * @param cover - The cover component to use.
     * @param opts - Options for the cover.
     */
    protected addCover(cover: Cover, opts?: Partial<AddCoverOptions>): Accessory {
        const o = opts ?? {};

        // get the config options for this cover
        const coverOpts = this.getComponentOptions<CoverOptions>(cover) ?? {};

        // determine the cover type
        const type = typeof coverOpts.type === 'string' ? coverOpts.type.toLowerCase() : 'window';
        const isDoor = type === 'door';
        const isWindowCovering = type === 'windowcovering';

        const id = o.single === true ? 'cover' : `cover-${cover.id}`;

        return this.createAccessory(
            id,
            'Cover',
            new CoverAbility(cover, 'door').setActive(isDoor),
            new CoverAbility(cover, 'windowCovering').setActive(isWindowCovering),
            new CoverAbility(cover, 'window').setActive(!isDoor && !isWindowCovering),
            new PowerMeterAbility(cover),
        ).setActive(coverOpts.exclude !== true && o.active !== false);
    }

    /**
     * Creates an accessory for a light component.
     * @param light - The light component to use.
     * @param opts - Options for the light.
     */
    protected addLight(light: Light, opts?: Partial<AddLightOptions>): Accessory {
        const o = opts ?? {};

        // get the config options for this light
        const lightOpts = this.getComponentOptions<LightOptions>(light) ?? {};

        const id = o.single === true ? 'light' : `light-${light.id}`;
        const nameSuffix = o.single === true ? null : `Light ${light.id + 1}`;

        return this.createAccessory(id, nameSuffix, new LightAbility(light)).setActive(
            lightOpts.exclude !== true && o.active !== false,
        );
    }

    /**
     * Creates HomeKit accessories for supported Shelly Add-on components reported by this device.
     */
    protected async addAddonSensors() {
        const addonOpts = this.options.addon ?? {};
        if (addonOpts.autoDiscover === false) {
            return;
        }

        const components = this.dedupeComponentsByKey([
            ...this.getDeviceComponents(),
            ...(await this.getRpcAddonComponents()),
        ]);
        this.log.debug(
            'Shelly Add-on combined autodiscovery components: ' +
                (components.length > 0 ? components.map((component) => component.key).join(', ') : 'none'),
        );

        if (
            this.options.addon &&
            !components.some(
                (component) =>
                    component.key.startsWith('temperature:') ||
                    component.key.startsWith('humidity:') ||
                    component.key.startsWith('input:') ||
                    component.key.startsWith('voltmeter:'),
            )
        ) {
            this.log.info(
                'Shelly Add-on autodiscovery is enabled, but no add-on components were exposed by the device library',
            );
        }

        if (addonOpts.temperature !== false) {
            for (const component of components.filter((c) => c.key.startsWith('temperature:'))) {
                const ability = new TemperatureSensorAbility(component);
                this.registerRpcAddonAbility(component, ability);
                this.createAccessory(`temperature-${component.id}`, `Temperature ${component.id + 1}`, ability);
            }
        }

        if (addonOpts.humidity !== false) {
            for (const component of components.filter((c) => c.key.startsWith('humidity:'))) {
                const ability = new HumiditySensorAbility(component);
                this.registerRpcAddonAbility(component, ability);
                this.createAccessory(`humidity-${component.id}`, `Humidity ${component.id + 1}`, ability);
            }
        }

        if (addonOpts.digitalInput !== false) {
            for (const component of components.filter((c) => c.key.startsWith('input:') && this.isAddonInput(c))) {
                const ability = new ContactSensorAbility(component);
                this.registerRpcAddonAbility(component, ability);
                this.createAccessory(`input-${component.id}`, `Input ${component.id + 1}`, ability);
            }
        }

        if (addonOpts.voltmeter !== false) {
            for (const component of components.filter((c) => c.key.startsWith('voltmeter:'))) {
                const ability = new VoltmeterAbility(component);
                this.registerRpcAddonAbility(component, ability);
                this.createAccessory(`voltmeter-${component.id}`, `Voltmeter ${component.id + 1}`, ability);
            }
        }

        if (addonOpts.analogInput !== false) {
            for (const component of components.filter(
                (c) => c.key.startsWith('input:') && this.isAddonAnalogInput(c),
            )) {
                this.log.info(
                    'Shelly Add-on analog input detected (' +
                        component.key +
                        '), but HomeKit exposure is not implemented yet',
                );
            }
        }

        this.startAddonPolling();
    }

    /**
     * Creates HomeKit accessories for supported Bluetooth/BTHome components reported by this Shelly gateway device.
     */
    protected async addBluetoothSensors() {
        const bluetoothOpts = this.options.bluetooth ?? {};
        if (bluetoothOpts.autoDiscover === false) {
            return;
        }

        const components = await this.getRpcBluetoothComponents();
        this.log.debug(
            'Shelly Bluetooth Gateway RPC components: ' +
                (components.length > 0 ? components.map((component) => component.key).join(', ') : 'none'),
        );

        if (this.options.bluetooth && components.length === 0) {
            this.log.info(
                'Shelly Bluetooth Gateway autodiscovery is enabled, but no BTHome components were exposed by the device',
            );
        }

        if (bluetoothOpts.temperature !== false) {
            for (const component of components.filter((c) => this.isBluetoothTemperatureSensor(c))) {
                const ability = new TemperatureSensorAbility(component);
                this.registerRpcBluetoothAbility(component, ability);
                this.createAccessory(
                    `bluetooth-temperature-${component.id}`,
                    `Bluetooth Temperature ${component.id + 1}`,
                    ability,
                );
            }
        }

        if (bluetoothOpts.humidity !== false) {
            for (const component of components.filter((c) => this.isBluetoothHumiditySensor(c))) {
                const ability = new HumiditySensorAbility(component);
                this.registerRpcBluetoothAbility(component, ability);
                this.createAccessory(
                    `bluetooth-humidity-${component.id}`,
                    `Bluetooth Humidity ${component.id + 1}`,
                    ability,
                );
            }
        }

        if (bluetoothOpts.battery !== false) {
            const batterySensorAddresses = new Set(
                components.filter((c) => this.isBluetoothBatterySensor(c)).map((c) => String(c.addr ?? '')),
            );

            for (const component of components.filter((c) => this.isBluetoothBatterySensor(c))) {
                const ability = new BatteryAbility(component);
                this.registerRpcBluetoothAbility(component, ability);
                this.createAccessory(
                    `bluetooth-battery-${component.id}`,
                    `Bluetooth Battery ${component.id + 1}`,
                    ability,
                );
            }

            for (const component of components.filter(
                (c) => this.isBluetoothDeviceWithBattery(c) && !batterySensorAddresses.has(String(c.addr ?? '')),
            )) {
                const ability = new BatteryAbility(component);
                this.registerRpcBluetoothAbility(component, ability);
                this.createAccessory(
                    `bluetooth-device-battery-${component.id}`,
                    `Bluetooth Battery ${component.id + 1}`,
                    ability,
                );
            }
        }

        if (bluetoothOpts.contact !== false) {
            for (const component of components.filter((c) => this.isBluetoothContactSensor(c))) {
                const ability = new ContactSensorAbility(component);
                this.registerRpcBluetoothAbility(component, ability);
                this.createAccessory(
                    `bluetooth-contact-${component.id}`,
                    `Bluetooth Contact ${component.id + 1}`,
                    ability,
                );
            }
        }

        this.startBluetoothPolling();
    }

    /**
     * Removes duplicate components reported by both the device library and RPC status.
     */
    protected dedupeComponentsByKey(components: DiscoverableComponent[]): DiscoverableComponent[] {
        const seen = new Set<string>();

        return components.filter((component) => {
            if (seen.has(component.key)) {
                return false;
            }

            seen.add(component.key);
            return true;
        });
    }

    /**
     * Starts polling RPC-backed add-on components.
     */
    protected startAddonPolling() {
        if (this.addonPollingInterval !== null || !this.options.hostname || this.rpcAddonComponents.size === 0) {
            return;
        }

        this.addonPollingInterval = setInterval(() => {
            void this.pollAddonSensors();
        }, 2 * 1000);
    }

    /**
     * Starts polling RPC-backed Bluetooth/BTHome components.
     */
    protected startBluetoothPolling() {
        if (
            this.bluetoothPollingInterval !== null ||
            !this.options.hostname ||
            this.rpcBluetoothComponents.size === 0
        ) {
            return;
        }

        const pollInterval = Math.max(5, this.options.bluetooth?.pollInterval ?? 10);
        this.bluetoothPollingInterval = setInterval(() => {
            void this.pollBluetoothSensors();
        }, pollInterval * 1000);
    }

    /**
     * Registers an ability that can be refreshed when an RPC-backed add-on component changes.
     */
    protected registerRpcAddonAbility(component: DiscoverableComponent, ability: RefreshableAddonAbility) {
        if (!this.rpcAddonComponents.has(component.key)) {
            return;
        }

        const abilities = this.rpcAddonAbilities.get(component.key) ?? [];
        abilities.push(ability);
        this.rpcAddonAbilities.set(component.key, abilities);
    }

    /**
     * Registers an ability that can be refreshed when an RPC-backed Bluetooth/BTHome component changes.
     */
    protected registerRpcBluetoothAbility(component: DiscoverableComponent, ability: RefreshableBluetoothAbility) {
        if (!this.rpcBluetoothComponents.has(component.key)) {
            return;
        }

        const abilities = this.rpcBluetoothAbilities.get(component.key) ?? [];
        abilities.push(ability);
        this.rpcBluetoothAbilities.set(component.key, abilities);
    }

    /**
     * Stops polling RPC-backed add-on components.
     */
    protected stopAddonPolling() {
        if (this.addonPollingInterval === null) {
            return;
        }

        clearInterval(this.addonPollingInterval);
        this.addonPollingInterval = null;
    }

    /**
     * Stops polling RPC-backed Bluetooth/BTHome components.
     */
    protected stopBluetoothPolling() {
        if (this.bluetoothPollingInterval === null) {
            return;
        }

        clearInterval(this.bluetoothPollingInterval);
        this.bluetoothPollingInterval = null;
    }

    /**
     * Refreshes RPC-backed add-on component values.
     */
    protected async pollAddonSensors() {
        await this.getRpcAddonComponents(true);
    }

    /**
     * Refreshes RPC-backed Bluetooth/BTHome component values.
     */
    protected async pollBluetoothSensors() {
        await this.getRpcBluetoothComponents(true);
    }

    /**
     * Returns add-on components directly from Shelly.GetStatus.
     * Some Shelly Add-on components are reported by RPC but are not exposed by the device library.
     */
    protected async getRpcAddonComponents(refreshAbilities = false): Promise<DiscoverableComponent[]> {
        if (!this.options.hostname) {
            return [];
        }

        try {
            const response = await fetch('http://' + this.options.hostname + '/rpc/Shelly.GetStatus');
            if (!response.ok) {
                this.log.warn('Failed to fetch Shelly.GetStatus for add-on autodiscovery: HTTP ' + response.status);
                return [];
            }

            const status = (await response.json()) as ShellyStatus;
            const components = Object.entries(status)
                .filter(
                    ([key]) =>
                        key.startsWith('temperature:') ||
                        key.startsWith('humidity:') ||
                        key.startsWith('input:') ||
                        key.startsWith('voltmeter:'),
                )
                .map(([key, value]) => this.createRpcAddonComponent(key, value, refreshAbilities));

            if (!refreshAbilities) {
                this.log.debug(
                    'Shelly Add-on RPC components: ' +
                        (components.length > 0 ? components.map((component) => component.key).join(', ') : 'none'),
                );
            }

            return components;
        } catch (e) {
            this.log.warn(
                'Failed to fetch Shelly.GetStatus for add-on autodiscovery:',
                e instanceof Error ? e.message : e,
            );
            return [];
        }
    }

    /**
     * Returns Bluetooth/BTHome components directly from Shelly.GetComponents.
     */
    protected async getRpcBluetoothComponents(refreshAbilities = false): Promise<DiscoverableComponent[]> {
        if (!this.options.hostname) {
            return [];
        }

        try {
            const response = await fetch('http://' + this.options.hostname + '/rpc/Shelly.GetComponents');
            if (!response.ok) {
                this.log.warn(
                    'Failed to fetch Shelly.GetComponents for Bluetooth Gateway autodiscovery: HTTP ' + response.status,
                );
                return [];
            }

            const status = (await response.json()) as ShellyComponentsResponse;
            const components = (status.components ?? [])
                .filter(
                    (entry): entry is ShellyComponentsEntry & { key: string } =>
                        typeof entry.key === 'string' &&
                        (entry.key.startsWith('bthomedevice:') || entry.key.startsWith('bthomesensor:')),
                )
                .map((entry) => this.createRpcBluetoothComponent(entry.key, entry, refreshAbilities));

            return components;
        } catch (e) {
            this.log.warn(
                'Failed to fetch Shelly.GetComponents for Bluetooth Gateway autodiscovery:',
                e instanceof Error ? e.message : e,
            );
            return [];
        }
    }

    /**
     * Creates a lightweight component object from a Shelly.GetStatus component entry.
     */
    protected createRpcAddonComponent(key: string, value: unknown, refreshAbilities: boolean): RpcAddonComponent {
        const existing = this.rpcAddonComponents.get(key);
        if (existing) {
            const changed = this.updateRpcAddonComponent(existing, value);
            if (refreshAbilities && changed) {
                this.refreshRpcAddonAbilities(key);
            }

            return existing;
        }

        const component = {
            id: this.resolveRpcAddonComponentId(key, value),
            key,
            on: () => component,
            off: () => component,
        } as unknown as RpcAddonComponent;

        this.updateRpcAddonComponent(component, value);
        this.rpcAddonComponents.set(key, component);
        return component;
    }

    /**
     * Creates a lightweight component object from a Shelly.GetComponents component entry.
     */
    protected createRpcBluetoothComponent(
        key: string,
        value: ShellyComponentsEntry,
        refreshAbilities: boolean,
    ): RpcBluetoothComponent {
        const existing = this.rpcBluetoothComponents.get(key);
        if (existing) {
            const changed = this.updateRpcBluetoothComponent(existing, value);
            if (refreshAbilities && changed) {
                this.refreshRpcBluetoothAbilities(key);
            }

            return existing;
        }

        const component = {
            id: this.resolveRpcBluetoothComponentId(key, value),
            key,
            on: () => component,
            off: () => component,
        } as unknown as RpcBluetoothComponent;

        this.updateRpcBluetoothComponent(component, value);
        this.rpcBluetoothComponents.set(key, component);
        return component;
    }

    /**
     * Resolves the numeric component ID from RPC status.
     */
    protected resolveRpcAddonComponentId(key: string, value: unknown): number {
        const status = typeof value === 'object' && value !== null ? (value as ShellyStatusComponent) : {};
        const parsedId = Number(key.split(':')[1]);
        return typeof status.id === 'number' ? status.id : Number.isFinite(parsedId) ? parsedId : 0;
    }

    /**
     * Resolves the numeric component ID from Shelly.GetComponents.
     */
    protected resolveRpcBluetoothComponentId(key: string, value: ShellyComponentsEntry): number {
        const parsedId = Number(key.split(':')[1]);
        const statusId = value.status?.id;
        const configId = value.config?.id;

        if (typeof statusId === 'number') {
            return statusId;
        }

        if (typeof configId === 'number') {
            return configId;
        }

        return Number.isFinite(parsedId) ? parsedId : 0;
    }

    /**
     * Updates a lightweight RPC-backed component.
     */
    protected updateRpcAddonComponent(component: RpcAddonComponent, value: unknown): boolean {
        const status = typeof value === 'object' && value !== null ? (value as ShellyStatusComponent) : {};
        let changed = false;

        for (const [property, newValue] of Object.entries(status)) {
            if (component[property] !== newValue) {
                changed = true;
            }

            component[property] = newValue;
        }

        return changed;
    }

    /**
     * Updates a lightweight RPC-backed Bluetooth/BTHome component.
     */
    protected updateRpcBluetoothComponent(component: RpcBluetoothComponent, value: ShellyComponentsEntry): boolean {
        let changed = false;

        for (const source of [value.config ?? {}, value.status ?? {}]) {
            for (const [property, newValue] of Object.entries(source)) {
                if (property === 'key') {
                    component.bthomeKey = newValue;
                    continue;
                }

                if (component[property] !== newValue) {
                    changed = true;
                }

                component[property] = newValue;
            }
        }

        return changed;
    }

    /**
     * Refreshes abilities attached to an RPC-backed add-on component.
     */
    protected refreshRpcAddonAbilities(key: string) {
        const abilities = this.rpcAddonAbilities.get(key) ?? [];

        for (const ability of abilities) {
            ability.refresh();
        }
    }

    /**
     * Refreshes abilities attached to an RPC-backed Bluetooth/BTHome component.
     */
    protected refreshRpcBluetoothAbilities(key: string) {
        const abilities = this.rpcBluetoothAbilities.get(key) ?? [];

        for (const ability of abilities) {
            ability.refresh();
        }
    }

    /**
     * Returns dynamic Shelly components that can be discovered from the device instance.
     */
    protected getDeviceComponents(): DiscoverableComponent[] {
        return Object.values(this.device).filter((value): value is DiscoverableComponent => {
            if (typeof value !== 'object' || value === null) {
                return false;
            }

            const component = value as Partial<DiscoverableComponent>;
            return (
                typeof component.id === 'number' &&
                typeof component.key === 'string' &&
                typeof component.on === 'function' &&
                typeof component.off === 'function'
            );
        });
    }

    /**
     * Returns whether the component looks like a Shelly Add-on digital input.
     */
    protected isAddonInput(component: DiscoverableComponent): boolean {
        return component.id >= 100 && typeof component.state === 'boolean';
    }

    /**
     * Returns whether the component looks like a Shelly Add-on analog input.
     */
    protected isAddonAnalogInput(component: DiscoverableComponent): boolean {
        return component.id >= 100 && (typeof component.percent === 'number' || typeof component.value === 'number');
    }

    /**
     * Returns the stable Shelly component key if it is usable.
     */
    protected getComponentKey(component: DiscoverableComponent): string | undefined {
        return typeof component.key === 'string' ? component.key : undefined;
    }

    /**
     * Returns whether the component looks like a Bluetooth/BTHome temperature sensor.
     */
    protected isBluetoothTemperatureSensor(component: DiscoverableComponent): boolean {
        const key = this.getComponentKey(component);

        return (
            key?.startsWith('bthomesensor:') === true && component.obj_id === 69 && typeof component.value === 'number'
        );
    }

    /**
     * Returns whether the component looks like a Bluetooth/BTHome humidity sensor.
     */
    protected isBluetoothHumiditySensor(component: DiscoverableComponent): boolean {
        const key = this.getComponentKey(component);

        return (
            key?.startsWith('bthomesensor:') === true && component.obj_id === 46 && typeof component.value === 'number'
        );
    }

    /**
     * Returns whether the component looks like a Bluetooth/BTHome battery sensor.
     */
    protected isBluetoothBatterySensor(component: DiscoverableComponent): boolean {
        const key = this.getComponentKey(component);

        return (
            key?.startsWith('bthomesensor:') === true && component.obj_id === 1 && typeof component.value === 'number'
        );
    }

    /**
     * Returns whether the component looks like a Bluetooth/BTHome device with a battery value.
     */
    protected isBluetoothDeviceWithBattery(component: DiscoverableComponent): boolean {
        const key = this.getComponentKey(component);

        return key?.startsWith('bthomedevice:') === true && typeof component.battery === 'number';
    }

    /**
     * Returns whether the component looks like a Bluetooth/BTHome contact sensor.
     */
    protected isBluetoothContactSensor(component: DiscoverableComponent): boolean {
        const key = this.getComponentKey(component);

        return key?.startsWith('bthomesensor:') === true && typeof component.state === 'boolean';
    }

    /**
     * Handles 'connect' events from the RPC handler.
     */
    protected handleConnect() {
        this.log.info('Device connected');
        this.connected = true;
    }

    /**
     * Handles 'disconnect' events from the RPC handler.
     */
    protected handleDisconnect(code: number, reason: string, reconnectIn: number | null) {
        const details = reason.length > 0 ? 'reason: ' + reason : 'code: ' + code;
        this.log.warn((this.connected ? 'Device disconnected' : 'Connection failed') + ' (' + details + ')');

        if (reconnectIn !== null) {
            let msg = 'Reconnecting in ';

            if (reconnectIn < 60 * 1000) {
                msg += Math.floor(reconnectIn / 1000) + ' second(s)';
            } else if (reconnectIn < 60 * 60 * 1000) {
                msg += Math.floor(reconnectIn / (60 * 1000)) + ' minute(s)';
            } else {
                msg += Math.floor(reconnectIn / (60 * 60 * 1000)) + ' hour(s)';
            }

            this.log.info(msg);
        }

        this.connected = false;
    }

    /**
     * Handles 'request' events from the RPC handler.
     */
    protected handleRequest(method: string) {
        this.log.debug('WebSocket:', method);
    }

    /**
     * Removes all event listeners from this device.
     */
    detach() {
        this.stopAddonPolling();
        this.stopBluetoothPolling();
        this.device.rpcHandler
            .off('connect', this.handleConnect, this)
            .off('disconnect', this.handleDisconnect, this)
            .off('request', this.handleRequest, this);

        // invoke detach() on all accessories
        for (const a of this.accessories.values()) {
            a.detach();
        }
    }

    /**
     * Destroys this device delegate, removing all event listeners and unregistering all accessories.
     */
    destroy() {
        this.detach();

        // find all platform accessories
        const pas = Array.from(this.accessories.values())
            .map((a) => a.platformAccessory)
            .filter((a) => a !== null) as PlatformAccessory[];

        if (pas.length > 0) {
            // remove the accessories from the platform
            this.platform.removeAccessory(...pas);
        }

        this.log.info('Device removed');
    }
}
