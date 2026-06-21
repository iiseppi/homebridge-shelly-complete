import { CharacteristicValue } from 'homebridge';
import { CharacteristicValue as ShelliesCharacteristicValue, ComponentLike, Switch } from '@lucavb/shellies-ds9';

import { Ability, ServiceClass } from './base.ts';
import { createEveDoorHistory, createEveRoomHistory, EveHistory } from '../utils/eve-history.ts';

export class SwitchAbility extends Ability {
    /**
     * @param component - The switch component to control.
     */
    constructor(readonly component: Switch) {
        super(`Switch ${component.id + 1}`, `switch-${component.id}`);
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.Switch;
    }

    protected initialize() {
        // set the initial value
        this.service.setCharacteristic(this.Characteristic.On, this.component.output);

        // listen for commands from HomeKit
        this.service.getCharacteristic(this.Characteristic.On).onSet(this.onSetHandler.bind(this));

        // listen for updates from the device
        this.component.on('change:output', this.outputChangeHandler, this);
    }

    detach() {
        this.component.off('change:output', this.outputChangeHandler, this);
    }

    /**
     * Handles changes to the Switch.On characteristic.
     */
    protected async onSetHandler(value: CharacteristicValue) {
        if (value === this.component.output) {
            return;
        }

        try {
            await this.component.set(value as boolean);
        } catch (e) {
            this.log.error('Failed to set switch:', e instanceof Error ? e.message : e);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    /**
     * Handles changes to the `output` property.
     */
    protected outputChangeHandler(value: ShelliesCharacteristicValue) {
        if (value) {
            this.log.info('Switch Status(' + this.component.id + '): on');
        } else {
            this.log.info('Switch Status(' + this.component.id + '): off');
        }
        this.service.getCharacteristic(this.Characteristic.On).updateValue(value as boolean);
    }
}

export class GarageDoorOpenerAbility extends Ability {
    private currentStateUpdateTimeout: ReturnType<typeof setTimeout> | null = null;

    /**
     * @param component - The switch component to control.
     * @param pulseDuration - The pulse duration, in seconds.
     */
    constructor(
        readonly component: Switch,
        readonly pulseDuration = 0.5,
    ) {
        super(`Garage Door ${component.id + 1}`, `garage-door-${component.id}`);
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.GarageDoorOpener;
    }

    protected initialize() {
        // set the initial values
        this.service.setCharacteristic(
            this.Characteristic.CurrentDoorState,
            this.Characteristic.CurrentDoorState.CLOSED,
        );
        this.service.setCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.CLOSED);
        this.service.setCharacteristic(this.Characteristic.ObstructionDetected, false);

        // listen for commands from HomeKit
        this.service.getCharacteristic(this.Characteristic.TargetDoorState).onSet(this.onSetHandler.bind(this));

        // listen for updates from the device
        this.component.on('change:output', this.outputChangeHandler, this);
    }

    detach() {
        if (this.currentStateUpdateTimeout !== null) {
            clearTimeout(this.currentStateUpdateTimeout);
            this.currentStateUpdateTimeout = null;
        }

        this.component.off('change:output', this.outputChangeHandler, this);
    }

    /**
     * Handles changes to the GarageDoorOpener.TargetDoorState characteristic.
     */
    protected async onSetHandler(value: CharacteristicValue) {
        const targetState = value as number;
        const isOpening = targetState === this.Characteristic.TargetDoorState.OPEN;

        this.service
            .getCharacteristic(this.Characteristic.CurrentDoorState)
            .updateValue(
                isOpening ? this.Characteristic.CurrentDoorState.OPENING : this.Characteristic.CurrentDoorState.CLOSING,
            );

        try {
            await this.component.set(true);
        } catch (e) {
            this.log.error('Failed to trigger garage door opener:', e instanceof Error ? e.message : e);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }

        setTimeout(() => {
            void this.resetGarageDoorOpenerRelay();
        }, this.pulseDuration * 1000);

        if (this.currentStateUpdateTimeout !== null) {
            clearTimeout(this.currentStateUpdateTimeout);
        }

        this.currentStateUpdateTimeout = setTimeout(
            () => {
                this.currentStateUpdateTimeout = null;
                this.service
                    .getCharacteristic(this.Characteristic.CurrentDoorState)
                    .updateValue(
                        isOpening
                            ? this.Characteristic.CurrentDoorState.OPEN
                            : this.Characteristic.CurrentDoorState.CLOSED,
                    );
            },
            Math.max(this.pulseDuration * 1000, 1000),
        );
    }

    /**
     * Resets the garage door opener relay after the configured pulse duration.
     */
    protected async resetGarageDoorOpenerRelay() {
        try {
            await this.component.set(false);
        } catch (e) {
            this.log.error('Failed to reset garage door opener relay:', e instanceof Error ? e.message : e);
        }
    }

    /**
     * Handles changes to the `output` property.
     */
    protected outputChangeHandler(value: ShelliesCharacteristicValue) {
        if (value) {
            this.log.info('Garage door opener relay(' + this.component.id + '): on');
        } else {
            this.log.info('Garage door opener relay(' + this.component.id + '): off');
        }
    }
}

type SensorComponent = ComponentLike & {
    id: number;
    key: string;
    on(event: string, handler: unknown, context: unknown): unknown;
    off(event: string, handler: unknown, context: unknown): unknown;
    [key: string]: unknown;
};

function readNumber(component: SensorComponent, ...keys: string[]): number | undefined {
    for (const key of keys) {
        const value = component[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
    }

    return undefined;
}

function readBoolean(component: SensorComponent, ...keys: string[]): boolean | undefined {
    for (const key of keys) {
        const value = component[key];
        if (typeof value === 'boolean') {
            return value;
        }
    }

    return undefined;
}

export class TemperatureSensorAbility extends Ability {
    private eveHistory: EveHistory | null = null;
    private eveHistoryInterval: ReturnType<typeof setInterval> | null = null;
    private lastTemperature: number | null = null;

    constructor(
        readonly component: SensorComponent,
        private readonly enableEveHistory = false,
    ) {
        super(`Temperature ${component.id + 1}`, `temperature-${component.id}`);
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.TemperatureSensor;
    }

    protected initialize() {
        if (this.enableEveHistory) {
            this.eveHistory = createEveRoomHistory(this.platform, this.platformAccessory, this.log);
            this.eveHistoryInterval = setInterval(() => this.recordEveHistory(), 10 * 60 * 1000);
        }

        this.updateCurrentTemperature(true);
        this.component.on('change:tC', this.temperatureChangeHandler, this);
    }

    detach() {
        if (this.eveHistoryInterval !== null) {
            clearInterval(this.eveHistoryInterval);
            this.eveHistoryInterval = null;
        }

        this.component.off('change:tC', this.temperatureChangeHandler, this);
    }

    protected temperatureChangeHandler() {
        this.updateCurrentTemperature(true);
    }

    refresh() {
        this.updateCurrentTemperature(true);
    }

    protected updateCurrentTemperature(recordHistoryOnChange = false) {
        const value = readNumber(this.component, 'tC', 'temperature', 'value');
        if (value === undefined) {
            return;
        }

        const changedSinceLastSeen = this.lastTemperature !== value;

        this.log.info('Temperature sensor(' + this.component.id + '): ' + value + ' °C');
        this.lastTemperature = value;

        if (recordHistoryOnChange && changedSinceLastSeen) {
            this.recordEveHistory();
        }

        this.service.getCharacteristic(this.Characteristic.CurrentTemperature).updateValue(value);
    }

    protected recordEveHistory() {
        if (this.eveHistory === null || this.lastTemperature === null) {
            return;
        }

        this.eveHistory.addTemperature(this.lastTemperature);
    }
}

export class HumiditySensorAbility extends Ability {
    private eveHistory: EveHistory | null = null;
    private eveHistoryInterval: ReturnType<typeof setInterval> | null = null;
    private lastHumidity: number | null = null;

    constructor(
        readonly component: SensorComponent,
        private readonly enableEveHistory = false,
    ) {
        super(`Humidity ${component.id + 1}`, `humidity-${component.id}`);
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.HumiditySensor;
    }

    protected initialize() {
        if (this.enableEveHistory) {
            this.eveHistory = createEveRoomHistory(this.platform, this.platformAccessory, this.log);
            this.eveHistoryInterval = setInterval(() => this.recordEveHistory(), 10 * 60 * 1000);
        }

        this.updateCurrentRelativeHumidity(true);
        this.component.on('change:rh', this.humidityChangeHandler, this);
    }

    detach() {
        if (this.eveHistoryInterval !== null) {
            clearInterval(this.eveHistoryInterval);
            this.eveHistoryInterval = null;
        }

        this.component.off('change:rh', this.humidityChangeHandler, this);
    }

    protected humidityChangeHandler() {
        this.updateCurrentRelativeHumidity(true);
    }

    refresh() {
        this.updateCurrentRelativeHumidity(true);
    }

    protected updateCurrentRelativeHumidity(recordHistoryOnChange = false) {
        const value = readNumber(this.component, 'rh', 'humidity', 'value');
        if (value === undefined) {
            return;
        }

        const changedSinceLastSeen = this.lastHumidity !== value;

        this.log.info('Humidity sensor(' + this.component.id + '): ' + value + ' %');
        this.lastHumidity = value;

        if (recordHistoryOnChange && changedSinceLastSeen) {
            this.recordEveHistory();
        }

        this.service.getCharacteristic(this.Characteristic.CurrentRelativeHumidity).updateValue(value);
    }

    protected recordEveHistory() {
        if (this.eveHistory === null || this.lastHumidity === null) {
            return;
        }

        this.eveHistory.addHumidity(this.lastHumidity);
    }
}

export class ContactSensorAbility extends Ability {
    private eveHistory: EveHistory | null = null;

    constructor(
        readonly component: SensorComponent,
        private readonly enableEveHistory = false,
    ) {
        super(`Input ${component.id + 1}`, `input-${component.id}`);
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.ContactSensor;
    }

    protected initialize() {
        if (this.enableEveHistory) {
            this.eveHistory = createEveDoorHistory(this.platform, this.platformAccessory, this.log);
        }

        this.updateContactSensorState();
        this.component.on('change:state', this.inputChangeHandler, this);
    }

    detach() {
        this.component.off('change:state', this.inputChangeHandler, this);
    }

    protected inputChangeHandler() {
        this.updateContactSensorState();
    }

    refresh() {
        this.updateContactSensorState();
    }

    protected updateContactSensorState() {
        const state = readBoolean(this.component, 'state', 'input');
        if (state === undefined) {
            return;
        }

        this.log.info('Contact sensor(' + this.component.id + '): ' + (state ? 'open' : 'closed'));
        this.recordEveHistory(state);
        this.service
            .getCharacteristic(this.Characteristic.ContactSensorState)
            .updateValue(
                state
                    ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
                    : this.Characteristic.ContactSensorState.CONTACT_DETECTED,
            );
    }

    protected recordEveHistory(open: boolean) {
        if (this.eveHistory === null) {
            return;
        }

        this.eveHistory.addContact(open);
    }
}

export class VoltmeterAbility extends Ability {
    constructor(readonly component: SensorComponent) {
        super(`Voltmeter ${component.id + 1}`, `voltmeter-${component.id}`);
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.Battery;
    }

    protected initialize() {
        this.updateVoltageLevel();
        this.component.on('change:voltage', this.voltageChangeHandler, this);
        this.component.on('change:xvoltage', this.voltageChangeHandler, this);
    }

    detach() {
        this.component.off('change:voltage', this.voltageChangeHandler, this);
        this.component.off('change:xvoltage', this.voltageChangeHandler, this);
    }

    protected voltageChangeHandler() {
        this.updateVoltageLevel();
    }

    refresh() {
        this.updateVoltageLevel();
    }

    protected updateVoltageLevel() {
        const voltage = readNumber(this.component, 'xvoltage', 'voltage');
        if (voltage === undefined) {
            return;
        }

        const level = Math.max(0, Math.min(100, Math.round((voltage / 10) * 100)));
        this.log.info('Voltmeter(' + this.component.id + '): ' + voltage + ' V');
        this.service.getCharacteristic(this.Characteristic.BatteryLevel).updateValue(level);
        this.service
            .getCharacteristic(this.Characteristic.ChargingState)
            .updateValue(this.Characteristic.ChargingState.NOT_CHARGEABLE);
        this.service
            .getCharacteristic(this.Characteristic.StatusLowBattery)
            .updateValue(this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    }
}

export class BatteryAbility extends Ability {
    constructor(readonly component: SensorComponent) {
        super(`Battery ${component.id + 1}`, `battery-${component.id}`);
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.Battery;
    }

    protected initialize() {
        this.updateBatteryLevel();
        this.component.on('change:battery', this.batteryChangeHandler, this);
        this.component.on('change:value', this.batteryChangeHandler, this);
    }

    detach() {
        this.component.off('change:battery', this.batteryChangeHandler, this);
        this.component.off('change:value', this.batteryChangeHandler, this);
    }

    protected batteryChangeHandler() {
        this.updateBatteryLevel();
    }

    refresh() {
        this.updateBatteryLevel();
    }

    protected updateBatteryLevel() {
        const battery = readNumber(this.component, 'battery', 'value');
        if (battery === undefined) {
            return;
        }

        const level = Math.max(0, Math.min(100, Math.round(battery)));
        this.log.info('Battery(' + this.component.id + '): ' + level + ' %');
        this.service.getCharacteristic(this.Characteristic.BatteryLevel).updateValue(level);
        this.service
            .getCharacteristic(this.Characteristic.ChargingState)
            .updateValue(this.Characteristic.ChargingState.NOT_CHARGEABLE);
        this.service
            .getCharacteristic(this.Characteristic.StatusLowBattery)
            .updateValue(
                level <= 20
                    ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                    : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
            );
    }
}
