import sdk, { Camera, DeviceManifest, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, HumiditySensor, MediaObject, MotionSensor, OauthClient, Refresh, ScryptedDeviceType, ScryptedInterface, Setting, Settings, TemperatureSetting, TemperatureUnit, Thermometer, ThermostatMode, VideoCamera, VideoStreamOptions } from '@scrypted/sdk';
import { ScryptedDeviceBase } from '@scrypted/sdk';
import qs from 'query-string';
import ClientOAuth2 from 'client-oauth2';
import { URL } from 'url';
import axios from 'axios';
import throttle from 'lodash/throttle';

const { deviceManager, mediaManager, endpointManager } = sdk;

let clientId = localStorage.getItem('clientId') || '827888101440-6jsq0saim1fh1abo6bmd9qlhslemok2t.apps.googleusercontent.com';
let clientSecret = localStorage.getItem('clientSecret') || 'nXgrebmaHNvZrKV7UDJV3hmg';
let projectId = localStorage.getItem('projectId') || '778da527-9690-4368-9c96-6872bb29e7a0';

let authorizationUri: string;
let client: ClientOAuth2;

function updateClient() {
    authorizationUri = `https://nestservices.google.com/partnerconnections/${projectId}/auth`
    client = new ClientOAuth2({
        clientId,
        clientSecret,
        accessTokenUri: 'https://www.googleapis.com/oauth2/v4/token',
        authorizationUri,
        scopes: [
            'https://www.googleapis.com/auth/sdm.service',
        ]
    });
}

updateClient();

const refreshFrequency = 20;

function fromNestMode(mode: string): ThermostatMode {
    switch (mode) {
        case 'HEAT':
            return ThermostatMode.Heat;
        case 'COOL':
            return ThermostatMode.Cool;
        case 'HEATCOOL':
            return ThermostatMode.HeatCool;
        case 'OFF':
            return ThermostatMode.Off;
    }
}
function toNestMode(mode: ThermostatMode): string {
    switch (mode) {
        case ThermostatMode.Heat:
            return 'HEAT';
        case ThermostatMode.Cool:
            return 'COOL';
        case ThermostatMode.HeatCool:
            return 'HEATCOOL';
        case ThermostatMode.Off:
            return 'OFF';
    }
}

class NestCamera extends ScryptedDeviceBase implements VideoCamera, MotionSensor {
    constructor(public provider: GoogleSmartDeviceAccess, public device: any) {
        super(device.name.split('/').pop());
        this.provider = provider;
        this.device = device;
    }

    async getVideoStream(options?: VideoStreamOptions): Promise<MediaObject> {
        const result = await this.provider.authPost(`/devices/${this.nativeId}:executeCommand`, {
            command: "sdm.devices.commands.CameraLiveStream.GenerateRtspStream",
            params: {}
        });

        const u = result.data.results.streamUrls.rtspUrl;

        return mediaManager.createFFmpegMediaObject({
            inputArguments: [
                "-rtsp_transport",
                "tcp",
                '-analyzeduration', '15000000',
                '-probesize', '100000000',
                "-reorder_queue_size",
                "1024",
                "-max_delay",
                "20000000",
                "-i",
                u.toString(),
            ]
        })
    }
    async getVideoStreamOptions(): Promise<void | VideoStreamOptions[]> {
    }
}

class NestThermostat extends ScryptedDeviceBase implements HumiditySensor, Thermometer, TemperatureSetting, Settings, Refresh {
    device: any;
    provider: GoogleSmartDeviceAccess;
    executeParams: any = {};

    executeThrottle = throttle(() => {
        const params = this.executeParams;
        this.executeParams = {};
        return this.provider.authPost(`/devices/${this.nativeId}:executeCommand`, {
            command: "sdm.devices.commands.ThermostatMode.SetMode",
            params,
        });
    }, 6000)

    constructor(provider: GoogleSmartDeviceAccess, device: any) {
        super(device.name.split('/').pop());
        this.provider = provider;
        this.device = device;

        this.reload();
    }

    reload() {
        const device = this.device;

        const modes: ThermostatMode[] = [];
        for (const mode of device.traits['sdm.devices.traits.ThermostatMode'].availableModes) {
            const nest = fromNestMode(mode);
            if (nest)
                modes.push(nest);
            else
                console.warn('unknown mode', mode);

        }
        this.thermostatAvailableModes = modes;
        this.thermostatMode = fromNestMode(device.traits['sdm.devices.traits.ThermostatMode'].mode);
        this.temperature = device.traits['sdm.devices.traits.Temperature'].ambientTemperatureCelsius;
        this.humidity = device.traits["sdm.devices.traits.Humidity"].ambientHumidityPercent;
        this.temperatureUnit = device.traits['sdm.devices.traits.Settings'] === 'FAHRENHEIT' ? TemperatureUnit.F : TemperatureUnit.C;
        const heat = device.traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius;
        const cool = device.traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius;

        if (this.thermostatMode === ThermostatMode.Heat) {
            this.thermostatSetpoint = heat;
            this.thermostatSetpointHigh = undefined;
            this.thermostatSetpointLow = undefined;
        }
        else if (this.thermostatMode === ThermostatMode.Cool) {
            this.thermostatSetpoint = cool;
            this.thermostatSetpointHigh = undefined;
            this.thermostatSetpointLow = undefined;
        }
        else if (this.thermostatMode === ThermostatMode.HeatCool) {
            this.thermostatSetpoint = undefined;
            this.thermostatSetpointHigh = heat;
            this.thermostatSetpointLow = cool;
        }
        else {
            this.thermostatSetpoint = undefined;
            this.thermostatSetpointHigh = undefined;
            this.thermostatSetpointLow = undefined;
        }
    }

    async refresh(refreshInterface: string, userInitiated: boolean): Promise<void> {
        const data = await this.provider.refresh();
        const device = data.devices.find(device => device.name.split('/').pop() === this.nativeId);
        if (!device)
            throw new Error('device missing from device list on refresh');
        this.device = device;
        this.reload();
    }

    async getRefreshFrequency(): Promise<number> {
        return refreshFrequency;
    }

    async getSettings(): Promise<Setting[]> {
        const ret: Setting[] = [];
        for (const key of Object.keys(this.device.traits['sdm.devices.traits.Settings'])) {
            ret.push({
                title: key,
                value: this.device.traits['sdm.devices.traits.Settings'][key],
                readonly: true,
            });
        }
        return ret;
    }
    async putSetting(key: string, value: string | number | boolean): Promise<void> {
    }
    async setThermostatMode(mode: ThermostatMode): Promise<void> {
        this.executeParams.mode = toNestMode(mode);
        await this.executeThrottle();
        await this.refresh(null, true);
    }
    async setThermostatSetpoint(degrees: number): Promise<void> {
        this.executeParams.heatCelsius = degrees;
        this.executeParams.coolCelsius = degrees;
        await this.executeThrottle();
        await this.refresh(null, true);
    }
    async setThermostatSetpointHigh(high: number): Promise<void> {
        this.executeParams.heatCelsius = high;
        await this.executeThrottle();
        await this.refresh(null, true);
    }
    async setThermostatSetpointLow(low: number): Promise<void> {
        this.executeParams.coolCelsius = low;
        await this.executeThrottle();
        await this.refresh(null, true);
    }
}

class GoogleSmartDeviceAccess extends ScryptedDeviceBase implements OauthClient, DeviceProvider, Settings, HttpRequestHandler {
    token: ClientOAuth2.Token;
    devices = new Map<string, any>();
    refreshThrottled = throttle(async () => {
        const response = await this.authGet('/devices');
        this.console.log('refresh headers', response.headers);
        this.console.log('refersh data', response.data);
        const userId = response.headers['user-id'];
        if (userId && this.storage.getItem('userId') !== userId) {
            try {
                await axios.post(`https://scrypted-gda-server.uw.r.appspot.com/register/${userId}`, {
                    endpoint: await endpointManager.getPublicCloudEndpoint(),
                });
                this.storage.setItem('userId', userId);
            }
            catch (e) {
                this.console.error('register error', e);
            }
        }
        return response.data;
    }, refreshFrequency * 1000);

    constructor() {
        super();
        this.discoverDevices(0).catch(() => { });
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const payload = JSON.parse(Buffer.from(JSON.parse(request.body).message.data, 'base64').toString());
        this.console.log(payload);

        const traits = payload.resourceUpdate?.traits;
        const events = payload.resourceUpdate?.events;

        const nativeId = payload.resourceUpdate.name.split('/').pop();
        const device = this.devices.get(nativeId);
        if (device ) {
            if (traits) {
                Object.assign(device.traits, traits);
                if (device.type === 'sdm.devices.types.THERMOSTAT') {
                    new NestThermostat(this, device);
                }
                else if (device.type === 'sdm.devices.types.CAMERA') {
                    new NestCamera(this, device);
                }
            }

            if (events) {
                if (device.type === 'sdm.devices.types.CAMERA') {
                    if (events['sdm.devices.events.CameraMotion.Motion']) {
                        const camera = new NestCamera(this, device);
                        camera.motionDetected = true;
                        setTimeout(() => camera.motionDetected = false, 30000);
                    }
                }
            }
        }


        response.send('ok');
    }

    async getSettings(): Promise<Setting[]> {
        return [
            {
                title: 'Project ID',
                description: 'Google Device Access Project ID',
                value: localStorage.getItem('clientId') || '827888101440-6jsq0saim1fh1abo6bmd9qlhslemok2t.apps.googleusercontent.com',
            },
            {
                title: 'Client ID',
                description: 'Google Device Access Client ID',
                value: localStorage.getItem('projectId') || '778da527-9690-4368-9c96-6872bb29e7a0',
            },
            {
                title: 'Client Secret',
                description: 'Google Device Access Client Secret',
                value: localStorage.getItem('clientSecret') || 'nXgrebmaHNvZrKV7UDJV3hmg',
            },
        ];
    }

    async putSetting(key: string, value: string | number | boolean): Promise<void> {
        localStorage.setItem(key, value as string);
        updateClient();
        this.token = undefined;
        this.refresh();
    }

    async loadToken() {
        try {
            if (!this.token) {
                this.token = client.createToken(JSON.parse(localStorage.getItem('token')));
                this.token.expiresIn(-1000);
            }
        }
        catch (e) {
            this.log.a('Missing token. Please log in.');
            throw new Error('Missing token. Please log in.');
        }
        if (this.token.expired()) {
            this.token = await this.token.refresh();
            this.saveToken();
        }
    }

    saveToken() {
        localStorage.setItem('token', JSON.stringify(this.token.data));
    }

    async refresh(): Promise<any> {
        return this.refreshThrottled();
    }

    async getOauthUrl(): Promise<string> {
        const params = {
            client_id: clientId,
            access_type: 'offline',
            prompt: 'consent',
            response_type: 'code',
            scope: 'https://www.googleapis.com/auth/sdm.service',
        }
        return `${authorizationUri}?${qs.stringify(params)}`;
    }
    async onOauthCallback(callbackUrl: string) {
        const cb = new URL(callbackUrl);
        cb.search = '';
        const redirectUri = cb.toString();
        this.token = await client.code.getToken(callbackUrl, {
            redirectUri,
        });
        this.saveToken();

        this.discoverDevices(0).catch(() => { });
    }

    async authGet(path: string) {
        await this.loadToken();
        return axios(`https://smartdevicemanagement.googleapis.com/v1/enterprises/${projectId}${path}`, {
            // validateStatus() {
            //     return true;
            // },
            headers: {
                Authorization: `Bearer ${this.token.accessToken}`
            }
        });
    }

    async authPost(path: string, data: any) {
        await this.loadToken();
        return axios.post(`https://smartdevicemanagement.googleapis.com/v1/enterprises/${projectId}${path}`, data, {
            headers: {
                Authorization: `Bearer ${this.token.accessToken}`
            }
        });
    }

    async discoverDevices(duration: number): Promise<void> {
        let data: any;
        while (true) {
            try {
                data = await this.refresh();
                break;
            }
            catch (e) {
                await new Promise(resolve => setTimeout(resolve, refreshFrequency * 1000));
                console.error(e);
            }
        }

        // const structuresResponse = await this.authGet('/structures');

        const deviceManifest: DeviceManifest = {
            devices: [],
        };
        this.devices.clear();
        for (const device of data.devices) {
            const nativeId = device.name.split('/').pop();
            if (device.type === 'sdm.devices.types.THERMOSTAT') {
                this.devices.set(nativeId, device);

                deviceManifest.devices.push({
                    name: device.traits?.['sdm.devices.traits.Info']?.customName || device.parentRelations?.[0]?.displayName,
                    nativeId: nativeId,
                    type: ScryptedDeviceType.Thermostat,
                    interfaces: [
                        ScryptedInterface.Refresh,
                        ScryptedInterface.TemperatureSetting,
                        ScryptedInterface.HumiditySensor,
                        ScryptedInterface.Thermometer,
                        ScryptedInterface.Settings,
                    ]
                })
            }
            else if (device.type === 'sdm.devices.types.CAMERA') {
                this.devices.set(nativeId, device);

                deviceManifest.devices.push({
                    name: device.traits?.['sdm.devices.traits.Info']?.customName || device.parentRelations?.[0]?.displayName,
                    nativeId: nativeId,
                    type: ScryptedDeviceType.Camera,
                    interfaces: [
                        ScryptedInterface.VideoCamera,
                        ScryptedInterface.MotionSensor,
                    ]
                })
            }
        }

        deviceManager.onDevicesChanged(deviceManifest);
    }

    getDevice(nativeId: string) {
        const device = this.devices.get(nativeId);
        if (!device)
            return;
        if (device.type === 'sdm.devices.types.THERMOSTAT') {
            return new NestThermostat(this, device);
        }
        else if (device.type === 'sdm.devices.types.CAMERA') {
            return new NestCamera(this, device);
        }
    }
}

export default new GoogleSmartDeviceAccess();
