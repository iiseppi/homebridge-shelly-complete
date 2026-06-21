import { PlatformAccessory } from 'homebridge';

import { ShellyPlatform } from '../platform.ts';
import { DeviceLogger } from './device-logger.ts';

export type EveHistoryType = 'room' | 'weather' | 'door';

export type EveHistoryEntry = Record<string, number>;

/**
 * Returns the current unix timestamp in seconds, as expected by fakegato-history.
 */
function now(): number {
    return Math.round(Date.now() / 1000);
}

/**
 * Small wrapper around fakegato-history.
 *
 * This helper only writes history data to the Homebridge/HomeKit accessory. It never writes settings or data back to
 * any Shelly device.
 */
export class EveHistory {
    protected readonly history;
    protected lastTemperature: number | null = null;
    protected lastHumidity: number | null = null;
    protected lastRoomEntrySignature: string | null = null;
    protected lastRoomEntryTime = 0;

    constructor(
        platform: ShellyPlatform,
        accessory: PlatformAccessory,
        protected readonly log: DeviceLogger,
        type: EveHistoryType,
    ) {
        this.history = new platform.FakeGatoHistoryService(type, accessory, {
            log,
            storage: 'fs',
            path: platform.storagePath,
        });
    }

    /**
     * Records a temperature value in Eve history.
     */
    addTemperature(temperature: number) {
        this.lastTemperature = temperature;
        this.addRoomEntry();
    }

    /**
     * Records a humidity value in Eve history.
     */
    addHumidity(humidity: number) {
        this.lastHumidity = humidity;
        this.addRoomEntry();
    }

    /**
     * Records a contact sensor state in Eve history.
     */
    addContact(open: boolean) {
        this.addEntry({ status: open ? 1 : 0 });
    }

    /**
     * Records the latest room sensor state in Eve history.
     *
     * Eve room history works best when temperature and humidity from the same physical sensor are written as one entry.
     * Single-value temperature sensors, such as DS18B20, still record temperature-only entries.
     */
    protected addRoomEntry() {
        const entry: EveHistoryEntry = {};

        if (this.lastTemperature !== null) {
            entry.temp = this.lastTemperature;
        }

        if (this.lastHumidity !== null) {
            entry.humidity = this.lastHumidity;
        }

        if (Object.keys(entry).length === 0) {
            return;
        }

        const entryTime = now();
        const signature = JSON.stringify(entry);
        if (this.lastRoomEntrySignature === signature && entryTime - this.lastRoomEntryTime < 5) {
            return;
        }

        this.lastRoomEntrySignature = signature;
        this.lastRoomEntryTime = entryTime;
        this.addEntry(entry, entryTime);
    }

    /**
     * Records a generic fakegato-history entry.
     */
    protected addEntry(entry: EveHistoryEntry, entryTime = now()) {
        try {
            this.history.addEntry({ time: entryTime, ...entry });
        } catch (e) {
            this.log.warn('Failed to add Eve history entry:', e instanceof Error ? e.message : e);
        }
    }
}

/**
 * Creates an Eve room history service for temperature and humidity sensors.
 */
export function createEveRoomHistory(
    platform: ShellyPlatform,
    accessory: PlatformAccessory,
    log: DeviceLogger,
): EveHistory {
    return new EveHistory(platform, accessory, log, 'room');
}

/**
 * Creates an Eve door history service for contact sensors.
 */
export function createEveDoorHistory(
    platform: ShellyPlatform,
    accessory: PlatformAccessory,
    log: DeviceLogger,
): EveHistory {
    return new EveHistory(platform, accessory, log, 'door');
}
