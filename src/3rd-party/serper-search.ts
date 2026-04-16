import { AutoCastable, Prop } from 'civkit/civ-rpc';
import { HTTPService, HTTPServiceRequestOptions } from 'civkit/http';
import _ from 'lodash';
import { Agent, RetryAgent } from 'undici';

export const WORLD_COUNTRIES = { "AD": ["Andorra", "Andorran"], "AE": ["United Arab Emirates", "UAE", "Emirati"], "AF": ["Afghanistan", "Afghan"], "AG": ["Antigua and Barbuda", "Antiguan, Barbudan"], "AI": ["Anguilla", "Anguillian"], "AL": ["Albania", "Albanian"], "AM": ["Armenia", "Armenian"], "AN": "Netherlands Antilles", "AO": ["Angola", "Angolan"], "AQ": ["Antarctica", "Antarctican"], "AR": ["Argentina", "Argentine"], "AS": ["American Samoa", "American Samoan"], "AT": ["Austria", "Austrian"], "AU": ["Australia", "Australian"], "AW": ["Aruba", "Aruban"], "AX": ["Åland Islands", "Ålandish"], "AZ": ["Azerbaijan", "Azerbaijani"], "BA": ["Bosnia and Herzegovina", "Bosnian, Herzegovinian"], "BB": ["Barbados", "Barbadian"], "BD": ["Bangladesh", "Bangladeshi"], "BE": ["Belgium", "Belgian"], "BF": ["Burkina Faso", "Burkinabe"], "BG": ["Bulgaria", "Bulgarian"], "BH": ["Bahrain", "Bahraini"], "BI": ["Burundi", "Burundian"], "BJ": ["Benin", "Beninese"], "BM": ["Bermuda", "Bermudian"], "BN": ["Brunei Darussalam", "Bruneian"], "BO": ["Bolivia", "Bolivian"], "BR": ["Brazil", "Brazilian"], "BS": ["Bahamas", "Bahamian"], "BT": ["Bhutan", "Bhutanese"], "BV": "Bouvet Island", "BW": ["Botswana", "Motswana"], "BY": ["Belarus", "Belarusian"], "BZ": ["Belize", "Belizean"], "CA": ["Canada", "Canadian"], "CC": ["Cocos (Keeling) Islands", "Cocos Islander"], "CD": ["Congo, The Democratic Republic of the"], "CF": ["Central African Republic", "Central African"], "CG": ["Congo"], "CH": ["Switzerland", "Swiss"], "CI": ["Cote D'Ivoire", "Ivorian"], "CK": ["Cook Islands", "Cook Islander"], "CL": ["Chile", "Chilean"], "CM": ["Cameroon", "Cameroonian"], "CN": ["China", "Chinese"], "CO": ["Colombia", "Colombian"], "CR": ["Costa Rica", "Costa Rican"], "CU": ["Cuba", "Cuban"], "CV": ["Cape Verde", "Cape Verdian"], "CX": ["Christmas Island", "Christmas Islander"], "CY": ["Cyprus", "Cypriot"], "CZ": ["Czechia", "Czech Republic", "Czech"], "DE": ["Germany", "German"], "DJ": ["Djibouti"], "DK": ["Denmark", "Danish"], "DM": ["Dominica"], "DO": ["Dominican Republic"], "DZ": ["Algeria", "Algerian"], "EC": ["Ecuador", "Ecuadorean"], "EE": ["Estonia", "Estonian"], "EG": ["Egypt", "Egyptian"], "EH": ["Western Sahara", "Sahrawi"], "ER": ["Eritrea", "Eritrean"], "ES": ["Spain", "Spanish"], "ET": ["Ethiopia", "Ethiopian"], "EU": "European Union", "FI": ["Finland", "Finnish"], "FJ": ["Fiji", "Fijian"], "FK": ["Falkland Islands (Malvinas)", "Falkland Islander"], "FM": ["Micronesia, Federated States of", "Micronesian"], "FO": ["Faroe Islands", "Faroese"], "FR": ["France", "French"], "GA": ["Gabon", "Gabonese"], "GB": ["United Kingdom", "UK", "British"], "GD": ["Grenada", "Grenadian"], "GE": ["Georgia", "Georgian"], "GF": ["French Guiana", "Guianan"], "GG": ["Guernsey"], "GH": ["Ghana", "Ghanaian"], "GI": ["Gibraltar"], "GL": ["Greenland", "Greenlandic"], "GM": ["Gambia", "Gambian"], "GN": ["Guinea", "Guinean"], "GP": ["Guadeloupe", "Guadeloupian"], "GQ": ["Equatorial Guinea", "Equatorial Guinean"], "GR": ["Greece", "Greek"], "GS": ["South Georgia and the South Sandwich Islands", "South Georgian South Sandwich Islander"], "GT": ["Guatemala", "Guatemalan"], "GU": ["Guam", "Guamanian"], "GW": ["Guinea-Bissau", "Guinea-Bissauan"], "GY": ["Guyana", "Guyanese"], "HK": ["Hong Kong", "Hong Konger"], "HM": ["Heard Island and Mcdonald Islands", "Heard and McDonald Islander"], "HN": ["Honduras", "Honduran"], "HR": ["Croatia", "Croatian"], "HT": ["Haiti", "Haitian"], "HU": ["Hungary", "Hungarian"], "ID": ["Indonesia", "Indonesian"], "IE": ["Ireland", "Irish"], "IL": ["Israel", "Israeli"], "IM": ["Isle of Man", "Manx"], "IN": ["India", "Indian"], "IO": ["British Indian Ocean Territory"], "IQ": ["Iraq", "Iraqi"], "IR": ["Iran, Islamic Republic Of", "Iranian"], "IS": ["Iceland", "Icelander"], "IT": ["Italy", "Italian"], "JE": ["Jersey"], "JM": ["Jamaica", "Jamaican"], "JO": ["Jordan", "Jordanian"], "JP": ["Japan", "Japanese"], "KE": ["Kenya", "Kenyan"], "KG": ["Kyrgyzstan", "Kirghiz"], "KH": ["Cambodia", "Cambodian"], "KI": ["Kiribati", "I-Kiribati"], "KM": ["Comoros", "Comoran"], "KN": ["Saint Kitts and Nevis", "Kittitian or Nevisian"], "KP": ["Korea, Democratic People's Republic of", "North Korea", "North Korean", "DPRK"], "KR": ["Korea, Republic of", "South Korea", "South Korean"], "KW": ["Kuwait", "Kuwaiti"], "KY": ["Cayman Islands", "Caymanian"], "KZ": ["Kazakhstan", "Kazakhstani"], "LA": ["Lao People's Democratic Republic", "Laotian"], "LB": ["Lebanon", "Lebanese"], "LC": ["Saint Lucia", "Saint Lucian"], "LI": ["Liechtenstein", "Liechtensteiner"], "LK": ["Sri Lanka", "Sri Lankan"], "LR": ["Liberia", "Liberian"], "LS": ["Lesotho", "Mosotho"], "LT": ["Lithuania", "Lithuanian"], "LU": ["Luxembourg", "Luxembourger"], "LV": ["Latvia", "Latvian"], "LY": ["Libyan Arab Jamahiriya", "Libyan"], "MA": ["Morocco", "Moroccan"], "MC": ["Monaco", "Monegasque"], "MD": ["Moldova, Republic of", "Moldovan"], "ME": ["Montenegro", "Montenegrin"], "MG": ["Madagascar", "Malagasy"], "MH": ["Marshall Islands", "Marshallese"], "MK": ["Republic of North Macedonia", "North Macedonia", "Macedonia, The Former Yugoslav Republic of", "Macedonian"], "ML": ["Mali", "Malian"], "MM": ["Myanmar", "Burma", "Burmese"], "MN": ["Mongolia", "Mongolian"], "MO": ["Macao", "Macau", "Macanese"], "MP": ["Northern Mariana Islands"], "MQ": ["Martinique"], "MR": ["Mauritania", "Mauritanian"], "MS": ["Montserrat", "Montserratian"], "MT": ["Malta", "Maltese"], "MU": ["Mauritius", "Mauritian"], "MV": ["Maldives", "Maldivan"], "MW": ["Malawi", "Malawian"], "MX": ["Mexico", "Mexican"], "MY": ["Malaysia", "Malaysian"], "MZ": ["Mozambique", "Mozambican"], "NA": ["Namibia", "Namibian"], "NC": ["New Caledonia", "New Caledonian"], "NE": ["Niger", "Nigerien"], "NF": ["Norfolk Island", "Norfolk Islander"], "NG": ["Nigeria", "Nigerian"], "NI": ["Nicaragua", "Nicaraguan"], "NL": ["Netherlands", "Dutch"], "NO": ["Norway", "Norwegian"], "NP": ["Nepal", "Nepalese"], "NR": ["Nauru", "Nauruan"], "NU": ["Niue", "Niuean"], "NZ": ["New Zealand", "New Zealander"], "OM": ["Oman", "Omani"], "PA": ["Panama", "Panamanian"], "PE": ["Peru", "Peruvian"], "PF": ["French Polynesia", "French Polynesian"], "PG": ["Papua New Guinea", "Papua New Guinean"], "PH": ["Philippines", "Filipino"], "PK": ["Pakistan", "Pakistani"], "PL": ["Poland", "Polish"], "PM": ["Saint Pierre and Miquelon"], "PN": ["Pitcairn", "Pitcairn Islander"], "PR": ["Puerto Rico", "Puerto Rican"], "PS": ["Palestinian Territory, Occupied", "Palestine", "Palestinian"], "PT": ["Portugal", "Portuguese"], "PW": ["Palau", "Palauan"], "PY": ["Paraguay", "Paraguayan"], "QA": ["Qatar", "Qatari"], "RE": ["Reunion"], "RO": ["Romania", "Romanian"], "RS": ["Serbia", "Serbian"], "RU": ["Russian Federation", "Russian"], "RW": ["Rwanda", "Rwandan"], "SA": ["Saudi Arabia", "Saudi Arabian"], "SB": ["Solomon Islands", "Solomon Islander"], "SC": ["Seychelles", "Seychellois"], "SD": ["Sudan", "Sudanese"], "SE": ["Sweden", "Swedish"], "SG": ["Singapore", "Singaporean"], "SH": ["Saint Helena", "Saint Helenian"], "SI": ["Slovenia", "Slovene"], "SJ": ["Svalbard and Jan Mayen"], "SK": ["Slovakia", "Slovak"], "SL": ["Sierra Leone", "Sierra Leonean"], "SM": ["San Marino", "Sammarinese"], "SN": ["Senegal", "Senegalese"], "SO": ["Somalia", "Somali"], "SR": ["Suriname", "Surinamer"], "ST": ["Sao Tome and Principe", "Sao Tomean"], "SV": ["El Salvador", "Salvadoran"], "SY": ["Syrian Arab Republic", "Syrian"], "SZ": ["Swaziland", "Swazi"], "TC": ["Turks and Caicos Islands", "Turks and Caicos Islander"], "TD": ["Chad", "Chadian"], "TF": ["French Southern Territories"], "TG": ["Togo", "Togolese"], "TH": ["Thailand", "Thai"], "TJ": ["Tajikistan", "Tadzhik"], "TK": ["Tokelau", "Tokelauan"], "TL": ["Timor-Leste", "East Timorese"], "TM": ["Turkmenistan", "Turkmen"], "TN": ["Tunisia", "Tunisian"], "TO": ["Tonga", "Tongan"], "TR": ["Turkey", "Turkish"], "TT": ["Trinidad and Tobago", "Trinidadian"], "TV": ["Tuvalu", "Tuvaluan"], "TW": ["Taiwan", "Taiwanese"], "TZ": ["Tanzania, United Republic of", "Tanzanian"], "UA": ["Ukraine", "Ukrainian"], "UG": ["Uganda", "Ugandan"], "UM": ["United States Minor Outlying Islands"], "US": ["United States", "USA", "American"], "UY": ["Uruguay", "Uruguayan"], "UZ": ["Uzbekistan", "Uzbekistani"], "VA": ["Holy See (Vatican City State)", "Vatican"], "VC": ["Saint Vincent and the Grenadines", "Saint Vincentian"], "VE": ["Venezuela", "Venezuelan"], "VG": ["Virgin Islands, British"], "VI": ["Virgin Islands, U.S."], "VN": ["Vietnam", "Viet Nam", "Vietnamese"], "VU": ["Vanuatu", "Ni-Vanuatu"], "WF": ["Wallis and Futuna", "Wallis and Futuna Islander"], "WS": ["Samoa", "Samoan"], "XK": ["Kosovo", "Kosovar"], "YE": ["Yemen", "Yemeni"], "YT": ["Mayotte", "Mahoran"], "ZA": ["South Africa", "South African"], "ZM": ["Zambia", "Zambian"], "ZW": ["Zimbabwe", "Zimbabwean"] };
export const WORLD_LANGUAGES = [{ "code": "af", "name": "Afrikaans" }, { "code": "ak", "name": "Akan" }, { "code": "sq", "name": "Albanian" }, { "code": "am", "name": "Amharic" }, { "code": "ar", "name": "Arabic" }, { "code": "hy", "name": "Armenian" }, { "code": "az", "name": "Azerbaijani" }, { "code": "eu", "name": "Basque" }, { "code": "be", "name": "Belarusian" }, { "code": "bem", "name": "Bemba" }, { "code": "bn", "name": "Bengali" }, { "code": "bh", "name": "Bihari" }, { "code": "xx-bork", "name": "Bork, bork, bork!" }, { "code": "bs", "name": "Bosnian" }, { "code": "br", "name": "Breton" }, { "code": "bg", "name": "Bulgarian" }, { "code": "km", "name": "Cambodian" }, { "code": "ca", "name": "Catalan" }, { "code": "chr", "name": "Cherokee" }, { "code": "ny", "name": "Chichewa" }, { "code": "zh-cn", "name": "Chinese (Simplified)" }, { "code": "zh-tw", "name": "Chinese (Traditional)" }, { "code": "co", "name": "Corsican" }, { "code": "hr", "name": "Croatian" }, { "code": "cs", "name": "Czech" }, { "code": "da", "name": "Danish" }, { "code": "nl", "name": "Dutch" }, { "code": "xx-elmer ", "name": "Elmer Fudd" }, { "code": "en", "name": "English" }, { "code": "eo", "name": "Esperanto" }, { "code": "et", "name": "Estonian" }, { "code": "ee", "name": "Ewe" }, { "code": "fo", "name": "Faroese" }, { "code": "tl", "name": "Filipino" }, { "code": "fi", "name": "Finnish" }, { "code": "fr", "name": "French" }, { "code": "fy", "name": "Frisian" }, { "code": "gaa", "name": "Ga" }, { "code": "gl", "name": "Galician" }, { "code": "ka", "name": "Georgian" }, { "code": "de", "name": "German" }, { "code": "el", "name": "Greek" }, { "code": "gn", "name": "Guarani" }, { "code": "gu", "name": "Gujarati" }, { "code": "xx-hacker ", "name": "Hacker" }, { "code": "ht", "name": "Haitian Creole" }, { "code": "ha", "name": "Hausa" }, { "code": "haw", "name": "Hawaiian" }, { "code": "iw", "name": "Hebrew" }, { "code": "hi", "name": "Hindi" }, { "code": "hu", "name": "Hungarian" }, { "code": "is", "name": "Icelandic" }, { "code": "ig", "name": "Igbo" }, { "code": "id", "name": "Indonesian" }, { "code": "ia", "name": "Interlingua" }, { "code": "ga", "name": "Irish" }, { "code": "it", "name": "Italian" }, { "code": "ja", "name": "Japanese" }, { "code": "jw", "name": "Javanese" }, { "code": "kn", "name": "Kannada" }, { "code": "kk", "name": "Kazakh" }, { "code": "rw", "name": "Kinyarwanda" }, { "code": "rn", "name": "Kirundi" }, { "code": "xx-klingon", "name": "Klingon" }, { "code": "kg", "name": "Kongo" }, { "code": "ko", "name": "Korean" }, { "code": "kri", "name": "Krio (Sierra Leone)" }, { "code": "ku", "name": "Kurdish" }, { "code": "ckb", "name": "Kurdish (Soran\xee)" }, { "code": "ky", "name": "Kyrgyz" }, { "code": "lo", "name": "Laothian" }, { "code": "la", "name": "Latin" }, { "code": "lv", "name": "Latvian" }, { "code": "ln", "name": "Lingala" }, { "code": "lt", "name": "Lithuanian" }, { "code": "loz", "name": "Lozi" }, { "code": "lg", "name": "Luganda" }, { "code": "ach", "name": "Luo" }, { "code": "mk", "name": "Macedonian" }, { "code": "mg", "name": "Malagasy" }, { "code": "ms", "name": "Malay" }, { "code": "ml", "name": "Malayalam" }, { "code": "mt", "name": "Maltese" }, { "code": "mi", "name": "Maori" }, { "code": "mr", "name": "Marathi" }, { "code": "mfe", "name": "Mauritian Creole" }, { "code": "mo", "name": "Moldavian" }, { "code": "mn", "name": "Mongolian" }, { "code": "sr-ME", "name": "Montenegrin" }, { "code": "ne", "name": "Nepali" }, { "code": "pcm", "name": "Nigerian Pidgin" }, { "code": "nso", "name": "Northern Sotho" }, { "code": "no", "name": "Norwegian" }, { "code": "nn", "name": "Norwegian (Nynorsk)" }, { "code": "oc", "name": "Occitan" }, { "code": "or", "name": "Oriya" }, { "code": "om", "name": "Oromo" }, { "code": "ps", "name": "Pashto" }, { "code": "fa", "name": "Persian" }, { "code": "xx-pirate", "name": "Pirate" }, { "code": "pl", "name": "Polish" }, { "code": "pt", "name": "Portuguese" }, { "code": "pt-br", "name": "Portuguese (Brazil)" }, { "code": "pt-pt", "name": "Portuguese (Portugal)" }, { "code": "pa", "name": "Punjabi" }, { "code": "qu", "name": "Quechua" }, { "code": "ro", "name": "Romanian" }, { "code": "rm", "name": "Romansh" }, { "code": "nyn", "name": "Runyakitara" }, { "code": "ru", "name": "Russian" }, { "code": "gd", "name": "Scots Gaelic" }, { "code": "sr", "name": "Serbian" }, { "code": "sh", "name": "Serbo-Croatian" }, { "code": "st", "name": "Sesotho" }, { "code": "tn", "name": "Setswana" }, { "code": "crs", "name": "Seychellois Creole" }, { "code": "sn", "name": "Shona" }, { "code": "sd", "name": "Sindhi" }, { "code": "si", "name": "Sinhalese" }, { "code": "sk", "name": "Slovak" }, { "code": "sl", "name": "Slovenian" }, { "code": "so", "name": "Somali" }, { "code": "es", "name": "Spanish" }, { "code": "es-419", "name": "Spanish (Latin American)" }, { "code": "su", "name": "Sundanese" }, { "code": "sw", "name": "Swahili" }, { "code": "sv", "name": "Swedish" }, { "code": "tg", "name": "Tajik" }, { "code": "ta", "name": "Tamil" }, { "code": "tt", "name": "Tatar" }, { "code": "te", "name": "Telugu" }, { "code": "th", "name": "Thai" }, { "code": "ti", "name": "Tigrinya" }, { "code": "to", "name": "Tonga" }, { "code": "lua", "name": "Tshiluba" }, { "code": "tum", "name": "Tumbuka" }, { "code": "tr", "name": "Turkish" }, { "code": "tk", "name": "Turkmen" }, { "code": "tw", "name": "Twi" }, { "code": "ug", "name": "Uighur" }, { "code": "uk", "name": "Ukrainian" }, { "code": "ur", "name": "Urdu" }, { "code": "uz", "name": "Uzbek" }, { "code": "vi", "name": "Vietnamese" }, { "code": "cy", "name": "Welsh" }, { "code": "wo", "name": "Wolof" }, { "code": "xh", "name": "Xhosa" }, { "code": "yi", "name": "Yiddish" }, { "code": "yo", "name": "Yoruba" }, { "code": "zu", "name": "Zulu" }];

export class SerperSearchQueryParams extends AutoCastable {

    @Prop({
        required: true
    })
    q!: string;

    @Prop({
        desc: `Country`,
        type: new Set(Object.keys(WORLD_COUNTRIES).map((x) => x.toLowerCase())),
    })
    gl?: string;

    @Prop({
        desc: `location`,
    })
    location?: string;

    @Prop({
        desc: `Language`,
        type: new Set(WORLD_LANGUAGES.map((x) => x.code)),
    })
    hl?: string;

    @Prop({
        desc: `Data range`,
    })
    tbs?: `qdr:${'h' | 'd' | 'w' | 'm' | 'y'}`;

    @Prop({
        desc: `AutoCorrect, defaults to true`,
    })
    autocorrect?: boolean;

    @Prop({
        type: new Set([10, 20, 30, 40, 50, 100])
    })
    num?: number;

    @Prop()
    page?: number;
}

export interface SerperBaseResponse {
    searchParameters: SerperSearchQueryParams,
    relatedSearches?: string[];
    credits: number;
}
export interface SerperWebSearchResponse extends SerperBaseResponse {
    knowledgeGraph?: {
        title: string;
        type: string;
        website: string;
        imageUrl: string;
        description: string;
        descriptionSource: string;
        descriptionLink: string;
        attributes: { [k: string]: string; };
    },
    organic: {
        title: string;
        link: string;
        snippet: string;
        date?: string;
        siteLinks?: { title: string; link: string; }[];
        position: number,
    }[];
    topStories?: {
        title: string;
        link: string;
        source: string;
        data: string;
        imageUrl: string;
    }[];
}
export interface SerperImageSearchResponse extends SerperBaseResponse {
    images: {
        title: string;
        imageUrl: string;
        imageWidth: number;
        imageHeight: number;
        thumbnailUrl: string;
        thumbnailWidth: number;
        thumbnailHeight: number;
        source: string;
        domain: string;
        link: string;
        googleUrl: string;
        position: number;
    }[];
}
export interface SerperNewsSearchResponse extends SerperBaseResponse {
    news: {
        title: string;
        link: string;
        snippet: string;
        imageUrl?: string;
        source: string;
        date?: string;
        position: number;
    }[];
}

export type SerperSearchResponse = SerperWebSearchResponse | SerperImageSearchResponse | SerperNewsSearchResponse;

class SerperBaseHTTP extends HTTPService {
    webSearch(payload: SerperSearchQueryParams, opts?: typeof this['baseOptions']) {
        return this.postJson<SerperWebSearchResponse>('/search', payload, {
            ...opts,
            keepalive: true,
            responseType: 'json'
        });
    }
    imageSearch(payload: SerperSearchQueryParams, opts?: typeof this['baseOptions']) {
        return this.postJson<SerperImageSearchResponse>('/images', payload, {
            ...opts,
            keepalive: true,
            responseType: 'json'
        });
    }
    newsSearch(payload: SerperSearchQueryParams, opts?: typeof this['baseOptions']) {
        return this.postJson<SerperNewsSearchResponse>('/news', payload, {
            ...opts,
            keepalive: true,
            responseType: 'json',
        });
    }

    override async __processResponse(options: HTTPServiceRequestOptions, r: Response): Promise<any> {
        if (r.status !== 200) {
            throw await r.json();
        }

        return super.__processResponse(options, r);
    }
}

// For retry of `Retry-After` header
const overrideAgent = new RetryAgent(
    new Agent({
        allowH2: true
    }),
    {
        statusCodes: [429, 503, 500],
        maxRetries: 3,
        retryAfter: true,
        minTimeout: 200,
    }
);


export class SerperGoogleHTTP extends SerperBaseHTTP {
    name = 'SerperGoogleSearch';

    constructor(public apiKey: string) {
        super('https://google.serper.dev');

        this.baseHeaders['X-API-KEY'] = `${apiKey}`;

        Reflect.set(this.baseOptions, 'dispatcher', overrideAgent);
    }
}

export class SerperBingHTTP extends SerperBaseHTTP {
    name = 'SerperBingSearch';

    constructor(public apiKey: string) {
        super('https://bing.serper.dev');

        this.baseHeaders['X-API-KEY'] = `${apiKey}`;

        Reflect.set(this.baseOptions, 'dispatcher', overrideAgent);
    }
}

export class SerperBaiduHTTP extends SerperBaseHTTP {
    name = 'SerperBaiduSearch';

    constructor(public apiKey: string) {
        super('https://baidu.serper.dev');

        this.baseHeaders['X-API-KEY'] = `${apiKey}`;

        Reflect.set(this.baseOptions, 'dispatcher', overrideAgent);
    }
}