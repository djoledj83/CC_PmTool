import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { Toaster } from '@/components/ui/sonner';
import { APP_NAME } from '@/lib/appInfo';
import './index.css';

// Browser tab title follows the configured product name (VITE_APP_NAME).
document.title = APP_NAME;

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <BrowserRouter>
            <AuthProvider>
                <ThemeProvider>
                    <App />
                    <Toaster />
                </ThemeProvider>
            </AuthProvider>
        </BrowserRouter>
    </React.StrictMode>,
);
