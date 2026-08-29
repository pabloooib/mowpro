// ==========================================================================
// auth.js
// Gestiona inicio de sesión, registro, logout y la transición de pantalla
// entre el Login (glassmorphism) y la consola principal del DAW.
// ==========================================================================

import { auth } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// --- Referencias DOM ---
const loginScreen = document.getElementById("login-screen");
const daw = document.getElementById("daw");

const formLogin = document.getElementById("form-login");
const formRegister = document.getElementById("form-register");

const tabLogin = document.getElementById("tab-login");
const tabRegister = document.getElementById("tab-register");

const loginError = document.getElementById("login-error");
const registerError = document.getElementById("register-error");

const btnLogout = document.getElementById("btn-logout");
const userBadge = document.getElementById("user-email-badge");

// Callback inyectado por app.js, se ejecuta una vez autenticado
let onUserReady = () => {};
let onUserGone = () => {};

export function setAuthCallbacks({ onReady, onGone }) {
  onUserReady = onReady || onUserReady;
  onUserGone = onGone || onUserGone;
}

// --- Alternar pestañas Login / Registro ---
tabLogin.addEventListener("click", () => switchTab("login"));
tabRegister.addEventListener("click", () => switchTab("register"));

function switchTab(which) {
  const isLogin = which === "login";
  tabLogin.classList.toggle("active", isLogin);
  tabRegister.classList.toggle("active", !isLogin);
  formLogin.classList.toggle("hidden", !isLogin);
  formRegister.classList.toggle("hidden", isLogin);
  loginError.textContent = "";
  registerError.textContent = "";
}

// --- Envío de formularios ---
formLogin.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const btn = formLogin.querySelector("button[type='submit']");

  setLoading(btn, true);
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    loginError.textContent = friendlyError(err.code);
  } finally {
    setLoading(btn, false);
  }
});

formRegister.addEventListener("submit", async (e) => {
  e.preventDefault();
  registerError.textContent = "";
  const email = document.getElementById("register-email").value.trim();
  const password = document.getElementById("register-password").value;
  const confirm = document.getElementById("register-password-confirm").value;
  const btn = formRegister.querySelector("button[type='submit']");

  if (password !== confirm) {
    registerError.textContent = "Las contraseñas no coinciden.";
    return;
  }
  if (password.length < 6) {
    registerError.textContent = "La contraseña debe tener al menos 6 caracteres.";
    return;
  }

  setLoading(btn, true);
  try {
    await createUserWithEmailAndPassword(auth, email, password);
  } catch (err) {
    registerError.textContent = friendlyError(err.code);
  } finally {
    setLoading(btn, false);
  }
});

btnLogout.addEventListener("click", async () => {
  await signOut(auth);
});

// --- Observador global de sesión ---
onAuthStateChanged(auth, (user) => {
  if (user) {
    userBadge.textContent = user.email;
    revealDAW();
    onUserReady(user);
  } else {
    showLogin();
    onUserGone();
  }
});

// --- Transición visual Login -> DAW ---
function revealDAW() {
  if (!loginScreen.classList.contains("hidden")) {
    loginScreen.classList.add("fade-out");
    setTimeout(() => {
      loginScreen.classList.add("hidden");
      loginScreen.classList.remove("fade-out");
    }, 650);
  }
  daw.classList.remove("hidden");
  requestAnimationFrame(() => daw.classList.add("visible"));
}

function showLogin() {
  daw.classList.remove("visible");
  daw.classList.add("hidden");
  loginScreen.classList.remove("hidden", "fade-out");
}

function setLoading(button, isLoading) {
  button.disabled = isLoading;
  button.classList.toggle("loading", isLoading);
}

function friendlyError(code) {
  const map = {
    "auth/invalid-email": "El correo electrónico no es válido.",
    "auth/user-disabled": "Esta cuenta ha sido deshabilitada.",
    "auth/user-not-found": "No existe una cuenta con este correo.",
    "auth/wrong-password": "Contraseña incorrecta.",
    "auth/invalid-credential": "Credenciales incorrectas. Verifica tu correo y contraseña.",
    "auth/email-already-in-use": "Ya existe una cuenta con este correo.",
    "auth/weak-password": "La contraseña es demasiado débil.",
    "auth/network-request-failed": "Error de red. Revisa tu conexión.",
  };
  return map[code] || "Ocurrió un error inesperado. Intenta de nuevo.";
}
