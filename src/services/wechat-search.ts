import { singleton } from 'tsyringe';
import { GlobalLogger } from './logger';
import { AsyncService, DownstreamServiceFailureError, marshalErrorLike } from 'civkit';
import { SecretExposer } from '../shared/services/secrets';
import { WechatBlogQueryParams, WechatSearchHTTP } from '../shared/3rd-party/wechat-search';


@singleton()
export class WechatSearchService extends AsyncService {

  logger = this.globalLogger.child({ service: this.constructor.name });

  wechatSearchHTTP!: WechatSearchHTTP;

  constructor(
    protected globalLogger: GlobalLogger,
    protected secretExposer: SecretExposer,
  ) {
    super(...arguments);
  }

  override async init() {
    await this.dependencyReady();
    this.emit('ready');

    this.wechatSearchHTTP = new WechatSearchHTTP(this.secretExposer.WECHAT_SEARCH_API_KEY);
  }

  async search(query: WechatBlogQueryParams) {
    this.logger.info('searching for official account blogs', query);

    try {
      // get wechat blog search results and convert format
      const r = await this.wechatSearchHTTP.blogSearch(query);

      if (r.parsed.code > 100 && r.parsed.code < 200) {
        throw new DownstreamServiceFailureError({ message: `Search(wechat) failed` });
      }

      return r.parsed.data?.map((page: any) => {
        return {
          title: page.title,
          link: page.url,
          content: page.content,
          snippet: '',
          publishedTime: page.publish_time,
          date: page.publish_time_str,
        };
      });

    } catch (err: any) {
      this.logger.error(`Wechat search failed: ${err?.message}`, { err: marshalErrorLike(err) });
      throw new DownstreamServiceFailureError({ message: `Search(wechat) failed` });
    }
  }
}