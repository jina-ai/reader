import { singleton } from 'tsyringe';
import { GlobalLogger } from './logger';
import { AsyncService, DownstreamServiceFailureError, marshalErrorLike } from 'civkit';
import { SecretExposer } from '../shared/services/secrets';
import { DajalaWechatSearchHttp, WechatSearchHTTP } from '../shared/3rd-party/wechat-search';
import { SerperSearchQueryParams } from '../shared/3rd-party/serper-search';


@singleton()
export class WechatSearchService extends AsyncService {

  logger = this.globalLogger.child({ service: this.constructor.name });

  dajalaWechatSearchHttp!: DajalaWechatSearchHttp;

  constructor(
    protected globalLogger: GlobalLogger,
    protected secretExposer: SecretExposer,
  ) {
    super(...arguments);
  }

  override async init() {
    await this.dependencyReady();
    this.emit('ready');

    this.dajalaWechatSearchHttp = new DajalaWechatSearchHttp(this.secretExposer.WECHAT_SEARCH_API_KEY);
  }

  async search(query: SerperSearchQueryParams) {
    this.logger.info('searching for official account blogs', query);

    const client: WechatSearchHTTP = this.dajalaWechatSearchHttp;
    try {
      // get wechat blog search results and convert format
      const r = await client.blogSearch(client.transformSerpQuery(query));

      if (r.parsed.code > 100 && r.parsed.code < 200) {
        throw new DownstreamServiceFailureError({ message: `Search(wechat) failed` });
      }

      return client.toSerpResponse(r.parsed);

    } catch (err: any) {
      this.logger.error(`Wechat search failed: ${err?.message}`, { err: marshalErrorLike(err) });
      throw new DownstreamServiceFailureError({ message: `Search(wechat) failed` });
    }
  }
}