import { ParamValidationError } from 'civkit/civ-rpc';

export function cleanAttribute(attribute: string | null) {
    return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : '';
}


export function tryDecodeURIComponent(input: string) {
    try {
        return decodeURIComponent(input);
    } catch (err) {
        if (URL.canParse(input, 'http://localhost:3000')) {
            return input;
        }

        throw new ParamValidationError(`Invalid URIComponent: ${input}`);
    }
}


export async function* toAsyncGenerator<T>(val: T) {
    yield val;
}

export async function* toGenerator<T>(val: T) {
    yield val;
}

export function consumeGenerator(val: Generator, t: number = 3) {
    let i = 0;
    for (const _x of val) {
        if (t && ++i >= t) {
            break;
        }
    }
}
export async function consumeAsyncGenerator(val: AsyncGenerator, t: number = 3) {
    let i = 0;
    for await (const _x of val) {
        if (t && ++i >= t) {
            break;
        }
    }
}

export async function* raceAsyncGenerators<T>(
    ...generators: AsyncGenerator<T>[]
): AsyncGenerator<T> {
    if (generators.length === 0) {
        return;
    }

    let promises = generators.map((gen, index) =>
        gen.next().then((result) => ({ index, result }))
    );

    try {
        while (true) {
            const { index, result } = await Promise.race(promises);

            if (result.value !== undefined) {
                yield result.value;
            }

            if (result.done) {
                return;
            }

            // Replace the resolved promise with next call from same generator
            promises[index] = generators[index].next().then((result) => ({ index, result }));
        }
    } finally {
        // Clean up all generators
        for (const gen of generators) {
            gen.return?.(undefined);
        }
    }
}

export async function* delayGenerator(delayMs: number, it: AsyncGenerator<any>) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield* it;
}
export async function* timeoutGenerator(delayMs: number) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield undefined;
}

export async function finalYield<T>(it: AsyncGenerator<T>) {
    let finalVal;
    for await (const x of it) {
        finalVal = x;
    }

    return finalVal;
}

const SCALAR_TYPES = new Set<any>([String, Number, Boolean, BigInt]);
export function isScalarLike(type: unknown) {
    if (typeof type === 'object' || typeof type === 'function') {
        const cls = typeof type === 'function' ? type : (typeof type === 'object' && type) ? type.constructor : null;
        if (cls === null) {
            return false;
        }

        if (SCALAR_TYPES.has(cls)) {
            return true;
        }

        for (const x of SCALAR_TYPES) {
            if (cls.prototype instanceof x) {
                return true;
            }
        }
    } else if (typeof type === 'string' || typeof type === 'number' || typeof type === 'boolean' || typeof type === 'bigint') {
        return true;
    }


    return false;
}
