// ==========================================================================
// firebase-config.js
// Inicialización centralizada de Firebase (Auth, Firestore, Storage)
// Todos los demás módulos importan las instancias desde aquí.
// ==========================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "funnel-77b45.firebaseapp.com",
  projectId: "funnel-77b45",
  storageBucket: "funnel-77b45.firebasestorage.app",
  messagingSenderId: "346894896581",
  appId: "1:346894896581:web:0f603a594e5894e5b04fac",
  measurementId: "G-C6CM9433H3",
};

// --- Inicialización de la app y servicios ---
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Mantener la sesión activa entre recargas del navegador.
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn("[MOW PRO] No se pudo establecer la persistencia de sesión:", err);
});
