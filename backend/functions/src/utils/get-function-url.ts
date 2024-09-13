import { GoogleAuth } from 'google-auth-library';

/**
 * Get the URL of a given v2 cloud function.
 *
 * @param {string} name the function's name
 * @param {string} location the function's location
 * @return {Promise<string>} The URL of the function
 */
export async function getFunctionUrl(name: string, location = "us-central1") {
    const projectId = `reader-6b7dc`;
    const url = "https://cloudfunctions.googleapis.com/v2beta/" +
        `projects/${projectId}/locations/${location}/functions/${name}`;
    const auth = new GoogleAuth({
        scopes: 'https://www.googleapis.com/auth/cloud-platform',
    });
    const client = await auth.getClient();
    const res = await client.request<any>({ url });
    const uri = res.data?.serviceConfig?.uri;
    if (!uri) {
        throw new Error(`Unable to retreive uri for function at ${url}`);
    }
    return uri;
}
