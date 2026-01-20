// Inicializa Supabase
const supabaseClient = window.supabase.createClient(
  "https://axggbupenrrsqjhjhnbg.supabase.co",
  "sb-publishable-JAgRBxG15HHGxFdNXwsr4w_kSKBaIx1"
);

// Si ya hay sesión → ir al chatbot
(async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    window.location.href = "index.html";
  }
})();

const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const errorMsg = document.getElementById("errorMsg");

loginBtn.onclick = async () => {
  errorMsg.style.display = "none";

  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  if (!email || !password) {
    errorMsg.textContent = "Introduce email y contraseña";
    errorMsg.style.display = "block";
    return;
  }

  // Login con Supabase Auth
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    errorMsg.textContent = "Credenciales incorrectas";
    errorMsg.style.display = "block";
    return;
  }

  // Login correcto → ir al chatbot
  window.location.href = "index.html";
};
