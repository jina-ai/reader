import { GlobalAsyncContext } from 'civkit/async-context';
import { container, singleton } from 'tsyringe';

@singleton()
export class AsyncLocalContext extends GlobalAsyncContext { }

const instance = container.resolve(AsyncLocalContext);
Reflect.set(process, 'asyncLocalContext', instance);

export default instance;
