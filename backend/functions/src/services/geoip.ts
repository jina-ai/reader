import { container, singleton } from 'tsyringe';
import fsp from 'fs/promises';
import { CityResponse, Reader } from 'maxmind';
import { AsyncService, AutoCastable, Prop, runOnce } from 'civkit';
import { Logger } from '../shared';
import path from 'path';

export enum GEOIP_SUPPORTED_LANGUAGES {
    EN = 'en',
    ZH_CN = 'zh-CN',
    JA = 'ja',
    DE = 'de',
    FR = 'fr',
    ES = 'es',
    PT_BR = 'pt-BR',
    RU = 'ru',
}

export class GeoIPInfo extends AutoCastable {
    @Prop()
    code?: string;

    @Prop()
    name?: string;
}

export class GeoIPCountryInfo extends GeoIPInfo {
    @Prop()
    eu?: boolean;
}

export class GeoIPCityResponse extends AutoCastable {
    @Prop()
    continent?: GeoIPInfo;

    @Prop()
    country?: GeoIPCountryInfo;

    @Prop({
        arrayOf: GeoIPInfo
    })
    subdivisions?: GeoIPInfo[];

    @Prop()
    city?: string;

    @Prop({
        arrayOf: Number
    })
    coordinates?: [number, number, number];

    @Prop()
    timezone?: string;
}

@singleton()
export class GeoIPService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    mmdbCity!: Reader<CityResponse>;

    constructor(
        protected globalLogger: Logger,
    ) {
        super(...arguments);
    }


    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    @runOnce()
    async _lazyload() {
        const mmdpPath = path.resolve(__dirname, '..', '..', 'licensed', 'GeoLite2-City.mmdb');

        const dbBuff = await fsp.readFile(mmdpPath, { flag: 'r', encoding: null });

        this.mmdbCity = new Reader<CityResponse>(dbBuff);

        this.logger.info(`Loaded GeoIP database, ${dbBuff.byteLength} bytes`);
    }


    async lookupCity(ip: string, lang: GEOIP_SUPPORTED_LANGUAGES = GEOIP_SUPPORTED_LANGUAGES.EN) {
        await this._lazyload();

        const r = this.mmdbCity.get(ip);

        if (!r) {
            return undefined;
        }

        return GeoIPCityResponse.from({
            continent: r.continent ? {
                code: r.continent?.code,
                name: r.continent?.names?.[lang] || r.continent?.names?.en,
            } : undefined,
            country: r.country ? {
                code: r.country?.iso_code,
                name: r.country?.names?.[lang] || r.country?.names.en,
                eu: r.country?.is_in_european_union,
            } : undefined,
            city: r.city?.names?.[lang] || r.city?.names?.en,
            subdivisions: r.subdivisions?.map((x) => ({
                code: x.iso_code,
                name: x.names?.[lang] || x.names?.en,
            })),
            coordinates: r.location ? [
                r.location.longitude, r.location.latitude, r.location.accuracy_radius
            ] : undefined,
            timezone: r.location?.time_zone,
        });
    }

}

const instance = container.resolve(GeoIPService);

export default instance;
