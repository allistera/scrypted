import sdk, { Settings, MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, Setting, ScryptedInterface, ScryptedInterfaceProperty, MixinDeviceBase } from '@scrypted/sdk';
import { Bridge, Categories, HAPStorage } from './hap';
import os from 'os';
import { supportedTypes } from './common';
import './types'
import { CameraMixin } from './camera-mixin';
import { maybeAddBatteryService } from './battery';

const { systemManager, deviceManager } = sdk;

HAPStorage.storage();
class HAPLocalStorage {
    initSync(options?: any) {

    }
    getItem(key: string): any {
        const data = localStorage.getItem(key);
        if (!data)
            return;
        return JSON.parse(data);
    }
    setItemSync(key: string, value: any) {
        localStorage.setItem(key, JSON.stringify(value));
    }
    removeItemSync(key: string) {
        localStorage.removeItem(key);
    }

    persistSync() {

    }
}

(HAPStorage as any).INSTANCE.localStore = new HAPLocalStorage();

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

if (!localStorage.getItem('uuid')) {
    localStorage.setItem('uuid', uuidv4());
}

const uuid = localStorage.getItem('uuid');


const includeToken = 4;


class HomeKit extends ScryptedDeviceBase implements MixinProvider, Settings {
    bridge = new Bridge('Scrypted', uuid);

    constructor() {
        super();
        this.start();
    }

    getUsername() {
        return this.storage.getItem("mac") || (Object.entries(os.networkInterfaces()).filter(([iface, entry]) => iface.startsWith('en') || iface.startsWith('wlan')) as any)
            .flat().map(([iface, entry]) => entry).find(i => i.family == 'IPv4').mac;
    }

    async getSettings(): Promise<Setting[]> {
        return [
            {
                title: "Pairing Code",
                key: "pairingCode",
                readonly: true,
                value: "123-45-678",
            },
            {
                title: "Username Override",
                value: this.getUsername(),
                key: "mac",
            }
        ]
    }

    async putSetting(key: string, value: string | number | boolean): Promise<void> {
        this.storage.setItem(key, value.toString());
    }

    async start() {
        let defaultIncluded: any;
        try {
            defaultIncluded = JSON.parse(this.storage.getItem('defaultIncluded'));
        }
        catch (e) {
            defaultIncluded = {};
        }

        const plugins = await systemManager.getComponent('plugins');

        const accessoryIds = new Set<string>();

        for (const id of Object.keys(systemManager.getSystemState())) {
            const device = systemManager.getDeviceById(id);
            const supportedType = supportedTypes[device.type];
            if (!supportedType?.probe(device))
                continue;

            try {
                const mixins = (device.mixins || []).slice();
                if (!mixins.includes(this.id)) {
                    if (defaultIncluded[device.id] === includeToken)
                        continue;
                    mixins.push(this.id);
                    await plugins.setMixins(device.id, mixins);
                    defaultIncluded[device.id] = includeToken;
                }

            }
            catch (e) {
                console.error('error while checking device if syncable', e);
                throw e;
            }

            const accessory = supportedType.getAccessory(device);
            if (accessory) {
                accessoryIds.add(id);

                maybeAddBatteryService(device, accessory);

                if (supportedType.noBridge) {
                    accessory.publish({
                        username: '12:34:45:54:24:44',
                        pincode: '123-45-678',
                        port: Math.round(Math.random() * 30000 + 10000),
                        category: Categories.TELEVISION,
                    })
                }
                else {
                    this.bridge.addBridgedAccessory(accessory);
                }
            }
        }

        this.storage.setItem('defaultIncluded', JSON.stringify(defaultIncluded));

        this.bridge.publish({
            username: this.getUsername(),
            pincode: '123-45-678',
            port: Math.round(Math.random() * 30000 + 10000),
        }, true);

        systemManager.listen((eventSource, eventDetails, eventData) => {
            if (eventDetails.eventInterface !== ScryptedInterface.ScryptedDevice)
                return;

            if (!eventDetails.changed)
                return;

            if (eventDetails.property !== ScryptedInterfaceProperty.id) {
                if (!accessoryIds.has(eventSource?.id))
                    return;
            }

            const device = systemManager.getDeviceById(eventSource?.id);
            this.log.i(`Accessory descriptor changed: ${device?.name}. Requesting restart.`);
            deviceManager.requestRestart();
        });
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]) {
        const supportedType = supportedTypes[type];
        if (!supportedType?.probe({
            interfaces,
            type,
        })) {
            return null;
        }

        if ((type === ScryptedDeviceType.Camera || type === ScryptedDeviceType.Doorbell)
            && interfaces.includes(ScryptedInterface.VideoCamera)) {
            return [ScryptedInterface.Settings];
        }
        return [];
    }
    getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: { [key: string]: any }) {
        if ((mixinDeviceState.type === ScryptedDeviceType.Camera || mixinDeviceState.type === ScryptedDeviceType.Doorbell)
            && mixinDeviceInterfaces.includes(ScryptedInterface.VideoCamera)) {
            return new CameraMixin(mixinDevice, mixinDeviceInterfaces, mixinDeviceState, this.nativeId);
        }
        return mixinDevice;
    }

    async releaseMixin(id: string, mixinDevice: any) {
        const device = systemManager.getDeviceById(id);
        if (device.mixins?.includes(this.id)) {
            return;
        }
        this.log.i(`Accessory removed from HomeKit: ${device.name}. Requesting restart.`);
        deviceManager.requestRestart();
    }
}

export default new HomeKit();
