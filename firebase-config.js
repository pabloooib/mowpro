// ==========================================================================
// firebase-config.js
// Inicialización centralizada de Firebase (Auth, Firestore, Storage)
// Todos los demás módulos importan las instancias desde aquí.
// ==========================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAnalytics, isSupported as isAnalyticsSupported } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-analytics.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyD9SLrApckR3ZnepzH8a8TsDIpvxAbHl2I",
  authDomain: "mowpro-bd1c0.firebaseapp.com",
  projectId: "mowpro-bd1c0",
  storageBucket: "mowpro-bd1c0.firebasestorage.app",
  messagingSenderId: "231482090677",
  appId: "1:231482090677:web:9932ab2b99f36725640afc",
  measurementId: "G-Q337N1H85F",
};

// --- Inicialización de la app y servicios ---
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Analytics solo se inicializa si el navegador lo soporta (evita errores en
// entornos sin cookies de terceros o en modo incógnito estricto).
export let analytics = null;
isAnalyticsSupported()
  .then((supported) => {
    if (supported) analytics = getAnalytics(app);
  })
  .catch(() => {
    /* Analytics no disponible en este entorno; no es crítico para el DAW. */
  });

// Mantener la sesión activa entre recargas del navegador.
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn("[MOW PRO] No se pudo establecer la persistencia de sesión:", err);
});
