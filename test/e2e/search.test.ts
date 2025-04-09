import { TestHttpClient } from '../utils/http-client';

function calculateToken(data: any[], chargeAmountScaler: number) {
  const length = data.length;

  return 10000 * Math.ceil(length / 10) * chargeAmountScaler;
}

describe("Test normal cases", () => {
  let httpClient: TestHttpClient;
  let baseUri = 'http://localhost:3001';
  const apiKey = process.env.TEST_API_KEY;

  beforeAll(async() => {
    expect(apiKey).toBeDefined();

    httpClient = new TestHttpClient(apiKey!, baseUri);
  });

  afterAll(async() => {
    await httpClient.close();
  });

  it('[without api key]', async() => {
    const client = new TestHttpClient('', baseUri);
    try {
      await client.search({q: 'Jina AI'}, {
        headers: {
          'x-no-cache': 'true',
          'X-Respond-With': 'no-content',
          'Accept': 'application/json',
        }
      });
    } catch (e) {
      expect(e).toBeDefined();
      expect(e.code).toEqual(401);
      expect(e.message).toEqual('Invalid API key, please get a new one from https://jina.ai');
    }

  });

  /**
   * @description
   * Test:
   * - no content
   * - no fallback
   * - json response
   * - no links
   * - no images
   */
  fit("[without content][without fallback][json response]", async () => {
    const result = await httpClient.search({q: 'Jina AI'}, {
      headers: {
        'x-no-cache': 'true',
        'X-Respond-With': 'no-content',
        'Accept': 'application/json',
      }
    });
    const data = result.data;

    expect(result.code).toBe(200);
    expect(data).toBeDefined();
    expect(data.length).toBeGreaterThan(0);
    const firstMatch = data[0];
    expect(firstMatch.title).toBeDefined();
    expect(firstMatch.favicon).toBeUndefined();
    expect(firstMatch.content).toBeUndefined();
    expect(firstMatch.links).toBeUndefined();
    expect(firstMatch.images).toBeUndefined();

    const tokens = calculateToken(data, 1);

    expect(result.meta).toEqual({
      usage: {
        tokens
      }
    });
  });

  /**
   * @description
   * Test:
   * - no content
   * - with fallback
   * - json response
   * - no links
   * - no images
   */
  it('[without content][with fallback][json response]', async() => {
    const result = await httpClient.search({q: 'new Jeans Hanni 人格分析 存在口供偏差'}, {
      headers: {
        'x-no-cache': 'true',
        'X-Respond-With': 'no-content',
        'Accept': 'application/json',
      }
    });
    const data = result.data;

    expect(result.code).toBe(200);
    expect(data).toBeDefined();
    const tokens = calculateToken(data, 2);

    expect(result.meta).toEqual({
      fallback: 'new Jeans Hanni',
      usage: {
        tokens
      }
    });
  });

  /**
   * @description
   * Test:
   * - with content
   * - no fallback
   * - text response
   * - no links
   * - no images
   */
  it('[with content][without fallback][text response]', async () => {
    const result = await httpClient.search({q: 'Jina AI'}, {
      headers: {
        'x-no-cache': 'true',
        'X-Respond-With': 'no-content',
      },
      responseType: 'text',
    });

    expect(typeof result).toEqual('string');

    // extract 'Title' and 'URL Source'
    const titleRegex = /Title/g;
    const titles = result.matchAll(titleRegex);
    const titleArray = Array.from(titles);

    const urlRegex = /URL Source/g;
    const urls = result.matchAll(urlRegex);
    const urlArray = Array.from(urls);

    expect(titleArray.length).toEqual(urlArray.length);
  });


  /**
   * @description
   * Test:
   * - with content
   * - without fallback
   * - json response
   * - with favicon
   * - with links
   * - with images
   *
   */
  it("[with content][with favicon][without fallback][json response]", async () => {
    const result = await httpClient.search({q: 'Jina AI'}, {
      headers: {
        'x-no-cache': 'true',
        'Accept': 'application/json',
        'X-With-Favicons': 'true',
        'X-With-Images-Summary': 'true',
        'X-With-Links-Summary': 'true',
      }
    });
    const data = result.data;

    expect(result.code).toBe(200);
    expect(data).toBeDefined();
    expect(data.length).toBeGreaterThan(0);

    const firstMatch = data[0];
    expect(firstMatch.title).toBeDefined();
    expect(firstMatch.favicon).toBeDefined();
    expect(firstMatch.content).toBeDefined();
    expect(Object.keys(firstMatch.links).length).toBeGreaterThan(0);
    expect(Object.keys(firstMatch.images).length).toBeGreaterThan(0);

    const tokens = calculateToken(data, 1);

    expect(result.meta.usage.tokens).toBeGreaterThan(tokens)
  });
});