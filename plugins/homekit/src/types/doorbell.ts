
import { BinarySensor, ScryptedDevice, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk'
import { addSupportedType, DummyDevice, bindCharacteristic, supportedTypes } from '../common'
import { Characteristic, Service } from '../hap';
import { makeAccessory } from './common';

addSupportedType({
    type: ScryptedDeviceType.Doorbell,
    probe(device: DummyDevice): boolean {
        return device.interfaces.includes(ScryptedInterface.BinarySensor);
    },
    getAccessory: (device: ScryptedDevice & BinarySensor) => {
        const faux: DummyDevice = {
            interfaces: device.interfaces,
            type: device.type,
        };
        faux.type = ScryptedDeviceType.Camera;
        const cameraCheck = supportedTypes[ScryptedInterface.Camera];
        const accessory = cameraCheck.probe(faux) ? cameraCheck.getAccessory(device) : makeAccessory(device);

        const service = accessory.addService(Service.Doorbell);
        bindCharacteristic(device, ScryptedInterface.BinarySensor, service, Characteristic.ProgrammableSwitchEvent, () => !!device.binaryState, true);

        return accessory;
    }
});
