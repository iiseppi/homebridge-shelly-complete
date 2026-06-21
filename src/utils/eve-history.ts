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
        this.addEntry({ temp: temperature });
    }

    /**
     * Records a humidity value in Eve history.
     */
    addHumidity(humidity: number) {
        this.addEntry({ humidity });
    }

    /**
     * Records a contact sensor state in Eve history.
     */
    addContact(open: boolean) {
        this.addEntry({ status: open ? 1 : 0 });
    }

    /**
     * Records a generic fakegato-history entry.
     */
    protected addEntry(entry: EveHistoryEntry) {
        try {
            this.history.addEntry({ time: now(), ...entry });
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
