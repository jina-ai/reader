export class TestHttpClient {

  private controller: AbortController | null = null;

  constructor(
    public apiKey: string,
    public baseUri: string = 'http://localhost:3000'
  ) {
    this.baseUri = baseUri;
  }

  async request(uri: string, payload: any, options: any = {}) {
    this.controller = new AbortController();

    const response = await fetch(`${this.baseUri}${uri}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: JSON.stringify(payload),
      signal: this.controller.signal,
    });

    if (!response.ok) {
      let error: any;
      try {
        error = await response.json();
      } catch (e) {
        error = await response.text();
      }

      throw error;
    }

    if (options.responseType === 'json') {
      return await response.json();
    }
    if (options.responseType === 'text') {
      return await response.text();
    }

    throw new Error('Unsupported response type');
  }

  async search(payload: any, options: any = {}) {
    const data = await this.request('', payload, {
      responseType: 'json',
      method: 'POST',
      ...options,
    });

    return data;
  }

  // Add this close method to clean up connections
  async close() {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }

    // This helps resolve the open handle issue with Node's fetch
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}