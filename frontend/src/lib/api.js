import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export const api = axios.create({
    baseURL: `${API_URL}/api`,
    withCredentials: true,
});

let accessToken = null;
let onUnauthorized = null;

export function setAccessToken(token) {
    accessToken = token;
}

export function getAccessToken() {
    return accessToken;
}

export function setUnauthorizedHandler(handler) {
    onUnauthorized = handler;
}

api.interceptors.request.use((config) => {
    if (accessToken) {
        config.headers.Authorization = `Bearer ${accessToken}`;
    }
    return config;
});

let refreshPromise = null;

async function refreshAccessToken() {
    if (!refreshPromise) {
        refreshPromise = axios
            .post(
                `${API_URL}/api/auth/refresh`,
                {},
                { withCredentials: true },
            )
            .then((res) => {
                accessToken = res.data.accessToken;
                return res.data;
            })
            .finally(() => {
                refreshPromise = null;
            });
    }
    return refreshPromise;
}

api.interceptors.response.use(
    (res) => res,
    async (error) => {
        const original = error.config;
        const status = error.response?.status;

        const isAuthRoute = original?.url?.startsWith('/auth/');

        if (status === 401 && !original._retry && !isAuthRoute) {
            original._retry = true;
            try {
                const { accessToken: newToken } = await refreshAccessToken();
                original.headers.Authorization = `Bearer ${newToken}`;
                return api(original);
            } catch (refreshErr) {
                accessToken = null;
                if (onUnauthorized) onUnauthorized();
                return Promise.reject(refreshErr);
            }
        }

        return Promise.reject(error);
    },
);
