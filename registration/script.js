// ==========================================================
// === ФІНАЛЬНИЙ РОБОЧИЙ КОД ВОРОНКИ РЕЄСТРАЦІЇ ===
// === v3.0 (Сумісна версія + надійний запуск) ===
// ==========================================================

// --- ЧАСТИНА 1: ДОПОМІЖНІ ФУНКЦІЇ ---

const baseURL = 'https://limaxsport.top/testapi';

function setTokens(accessToken, refreshToken, expiresInSeconds) {
  localStorage.setItem('access_token', accessToken);
  if (refreshToken) {
    localStorage.setItem('refresh_token', refreshToken);
  }
  const now = new Date().getTime();
  const expiresInMs = (expiresInSeconds || 120 * 60) * 1000;
  const accessTokenExpiresAt = now + expiresInMs;
  localStorage.setItem(
    'access_token_expires_at',
    accessTokenExpiresAt.toString()
  );
}

function getAccessToken() {
  return localStorage.getItem('access_token');
}

async function fetchWithAuth(url, options = {}) {
  let token = getAccessToken();

  const headers = {
    ...options.headers,
    'Content-Type':
      (options.headers && options.headers['Content-Type']) ||
      'application/json',
  };

  let fetchOptions = { ...options, headers };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, fetchOptions);
    const responseData = await response.json().catch(() => {
      if (response.ok) return null;
      return { detail: `Помилка сервера: ${response.status}` };
    });
    return { data: responseData, response: response };
  } catch (error) {
    console.error(`fetchWithAuth: Помилка під час запиту до ${url}:`, error);
    throw error;
  }
}

/**
 * Надсилає подію аналітики воронки на бекенд (без очікування відповіді).
 * @param {string} stepId - ID кроку (напр., 'welcome', 'goal', 'confirmation').
 * @param {string} eventType - Тип події (напр., 'step_view', 'register_attempt', 'register_success').
 */
function trackFunnelEvent(stepId, eventType) {
  try {
    if (!funnelManager.state.funnelSessionId) {
      console.warn(
        'Неможливо відстежити подію: funnelSessionId ще не встановлено.'
      );
      return;
    }

    const payload = {
      session_id: funnelManager.state.funnelSessionId,
      step_id: stepId,
      event_type: eventType,
    };

    // Використовуємо fetch, але не очікуємо (await) відповіді.
    // Ми також додаємо keepalive: true, що є критичним для подій,
    // які відбуваються прямо перед перенаправленням (register_success).
    fetch(`${baseURL}/analytics/funnel-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch((err) => {
      // Локально ловимо помилку, щоб вона не зламала основний потік
      console.warn(`Помилка відправки аналітики (${stepId}):`, err.message);
    });
  } catch (error) {
    console.warn('Синхронна помилка trackFunnelEvent:', error.message);
  }
}

// Менеджер таймерів для повільного з'єднання ---
const loadingTimerManager = {
  timerId: null,
  element: null,

  start(statusElement, timeout = 10000) {
    // Зупиняємо попередній таймер, якщо він був
    this.stop();

    this.element = statusElement; // Запам'ятовуємо, де показувати повідомлення

    this.timerId = setTimeout(() => {
      if (this.element) {
        this.element.textContent =
          '⏳ Схоже, у вас повільний Інтернет. Зачекайте, будь ласка...';
        this.element.style.color = '#ffc107'; // Жовтий колір для попередження
      }
    }, timeout);
  },

  stop() {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    // Очищуємо повідомлення, тільки якщо воно було про повільний інтернет
    if (this.element && this.element.textContent.includes('⏳')) {
      this.element.textContent = '';
    }
    this.element = null;
  },
};
// --- КІНЕЦЬ НОВОГО БЛОКУ ---

const funnelManager = {
  elements: {
    overlay: null,
    modal: null,
    title: null,
    counter: null,
    content: null,
    backBtn: null,
    nextBtn: null,
    statusMsg: null,
  },
  state: {
    currentStepIndex: 0,
    isSubmitting: false,
    registrationData: {},
    countdownTimerId: null,
    funnelSessionId: null,
  },
  steps: [
    {
      id: 'welcome',
      title: 'Вітаємо у "Lily&Max sport" ⚡️',
      fields: [], // Цей крок не збирає дані
      render: () => `
                <p class="step-description">
                    Будь ласка, надайте відповіді на наступні запитання та отримайте <strong>персоналізований тренувальний план</strong>, який допоможе досягти вашої мети <strong>безпечно</strong> та в <strong>найкоротші терміни</strong>.
                </p>

                <div style="text-align: center; margin-top: 5px; margin-bottom: -10px;">
                    <img src="https://limaxsport.top/registration/2.gif" alt="Welcome Animation" style="max-width: 100%; height: auto; border-radius: 5px;">
                </div>
            `,
      validate: () => {
        // Перевіряти нічого не потрібно, просто дозволяємо йти далі
        return true;
      },
    },
    {
      id: 'goal',
      title: 'Яка ваша головна ціль?',
      fields: ['goal'],
      render: () => `
                <p class="step-description">Це допоможе нам зрозуміти ваші пріоритети 🎯</p>
                <select id="funnel-goal" class="funnel-input">
                    <option value="" disabled selected>-- Оберіть вашу ціль --</option>
                    <option value="lose weight">Схуднути</option>
                    <option value="gain muscle mass">Набрати м'язову масу</option>
                    <option value="maintain shape">Підтримувати форму</option>
                </select>
            `,
      validate: (data) => {
        const element = document.getElementById('funnel-goal');
        data.goal = element ? element.value : '';
        if (!data.goal) return 'Будь ласка, оберіть вашу ціль.';
        return true;
      },
    },
    {
      id: 'training_type',
      title: 'Де ви плануєте тренуватись?',
      fields: ['type_of_training'],
      render: () => `
                <p class="step-description">Вибір вплине на типи вправ, які вам будуть пропонуватися.</p>
                <select id="funnel-type-of-training" class="funnel-input">
                    <option value="" disabled selected>-- Оберіть вид тренувань --</option>
                    <option value="gym">Тренування в тренажерному залі</option>
                    <option value="home">Домашні та вуличні тренування</option>
                    <option value="both">Обидва варіанти</option>
                </select>
            `,
      validate: (data) => {
        const element = document.getElementById('funnel-type-of-training');
        data.type_of_training = element ? element.value : '';
        if (!data.type_of_training) return 'Будь ласка, оберіть вид тренувань.';
        return true;
      },
    },
    {
      id: 'daytime_activity',
      title: 'Ваша щоденна активність',
      fields: ['daytime_activity'],
      render: () => `
                <p class="step-description">Сидяча робота чи постійний рух 🔥? - оцініть свою активність поза тренуваннями.</p>
                <select id="funnel-daytime-activity" class="funnel-input">
                    <option value="" disabled selected>-- Оцініть активність --</option>
                    <option value="low">Низька (сидяча робота)</option>
                    <option value="average">Середня (періодично рухаюсь)</option>
                    <option value="high">Висока (фізична робота)</option>
                </select>
            `,
      validate: (data) => {
        const element = document.getElementById('funnel-daytime-activity');
        data.daytime_activity = element ? element.value : '';
        if (!data.daytime_activity)
          return 'Будь ласка, оцініть свою щоденну активність.';
        return true;
      },
    },
    {
      id: 'level_of_training',
      title: 'Ваш рівень підготовки',
      fields: ['level_of_training'],
      render: () => `
                <p class="step-description">Будьте чесними із собою, це важливо для вашої безпеки та ефективності 📈</p>
                <select id="funnel-level-of-training" class="funnel-input">
                    <option value="" disabled selected>-- Оберіть рівень --</option>
                    <option value="low">Низький (новачок)</option>
                    <option value="average">Середній (досвід є)</option>
                    <option value="high">Високий (професіонал)</option>
                </select>
            `,
      validate: (data) => {
        const element = document.getElementById('funnel-level-of-training');
        data.level_of_training = element ? element.value : '';
        if (!data.level_of_training)
          return 'Будь ласка, оберіть ваш рівень підготовки.';
        return true;
      },
    },
    {
      id: 'training_days',
      title: 'Бажана кількість тренувань на тиждень',
      fields: ['training_days_per_week'],
      render: () => `
                <p class="step-description">Це допоможе нам скласти збалансований графік навантажень та відновлення 🗓️</p>
                <select id="funnel-training-days-per-week" class="funnel-input">
                    <option value="" disabled selected>-- Оберіть кількість --</option>
                    <option value="2">2 тренування</option>
                    <option value="3">3 тренування</option>
                    <option value="4">4 тренування</option>
                </select>
            `,
      validate: (data) => {
        const element = document.getElementById(
          'funnel-training-days-per-week'
        );
        // Зберігаємо як число, а не рядок
        data.training_days_per_week = element
          ? parseInt(element.value, 10)
          : '';
        if (!data.training_days_per_week)
          return 'Будь ласка, вкажіть, скільки разів ви плануєте тренуватись.';
        return true;
      },
    },
    {
      id: 'measurements',
      title: 'Ваші антропометричні дані',
      fields: ['age', 'weight', 'height'],
      render: () => `
                <p class="step-description">Ці дані 📝 необхідні для розрахунку навантажень та рекомендацій.</p>
                <label for="funnel-age">Ваш вік:</label>
                <input type="number" id="funnel-age" class="funnel-input" placeholder="Наприклад: 28" min="14" max="100">
                <label for="funnel-weight">Ваша вага (кг):</label>
                <input type="number" id="funnel-weight" class="funnel-input" placeholder="Наприклад: 75.5" step="0.1" min="30" max="250">
                <label for="funnel-height">Ваш зріст (см):</label>
                <input type="number" id="funnel-height" class="funnel-input" placeholder="Наприклад: 180" min="100" max="250">
            `,
      validate: (data) => {
        const ageEl = document.getElementById('funnel-age');
        const weightEl = document.getElementById('funnel-weight');
        const heightEl = document.getElementById('funnel-height');
        data.age = ageEl ? ageEl.value : '';
        data.weight = weightEl ? weightEl.value : '';
        data.height = heightEl ? heightEl.value : '';
        if (!data.age || !data.weight || !data.height)
          return 'Будь ласка, заповніть всі поля.';
        return true;
      },
    },
    {
      id: 'gender',
      title: 'Вкажіть вашу стать',
      fields: ['gender', 'preferred_exercise_gender'],
      render: () => `
                <p class="step-description">Ми використовуємо цей показник, щоб пропонувати вам відповідний набір вправ (чоловічий або жіночий), оскільки вони мають різну специфіку та акценти.</p>
                <label for="funnel-gender">Ваша стать:</label>
                <select id="funnel-gender" class="funnel-input">
                    <option value="" disabled selected>-- Оберіть --</option>
                    <option value="male">Чоловіча</option>
                    <option value="female">Жіноча</option>
                    <option value="not_applicable">Не застосовується</option>
                </select>
                <div id="funnel-preferred-gender-container" style="display:none; margin-top: 20px;">
                    <label for="funnel-preferred-exercise-gender">Який набір вправ вам надавати?</label>
                    <select id="funnel-preferred-exercise-gender" class="funnel-input">
                        <option value="" disabled selected>-- Оберіть набір --</option>
                        <option value="male">Чоловічий набір вправ</option>
                        <option value="female">Жіночий набір вправ</option>
                    </select>
                </div>
            `,
      onRender: () => {
        const genderSelect = document.getElementById('funnel-gender');
        const preferredContainer = document.getElementById(
          'funnel-preferred-gender-container'
        );
        if (!genderSelect || !preferredContainer) return;
        genderSelect.addEventListener('change', (e) => {
          if (e.target.value === 'not_applicable') {
            preferredContainer.style.display = 'block';
          } else {
            preferredContainer.style.display = 'none';
          }
        });
        if (genderSelect.value === 'not_applicable') {
          preferredContainer.style.display = 'block';
        }
      },
      validate: (data) => {
        const genderEl = document.getElementById('funnel-gender');
        data.gender = genderEl ? genderEl.value : '';
        if (!data.gender) return 'Будь ласка, вкажіть вашу стать.';

        if (data.gender === 'not_applicable') {
          const preferredGenderEl = document.getElementById(
            'funnel-preferred-exercise-gender'
          );
          data.preferred_exercise_gender = preferredGenderEl
            ? preferredGenderEl.value
            : '';
          if (!data.preferred_exercise_gender)
            return 'Будь ласка, оберіть бажаний набір вправ.';
        } else {
          data.preferred_exercise_gender = null;
        }
        return true;
      },
    },
    {
      id: 'health',
      title: "Проблеми зі здоров'ям",
      subtitle: "(не обов'язково)",
      fields: ['health_problems', 'other_health_problems'],
      render: () => `
                <p class="step-description">Оберіть зі списку, якщо є. Це дозволить уникнути потенційно небезпечних вправ для вас ❤️</p>
        
                <div id="funnel-health-problems-list" class="health-problems-list">
                    </div>

                <label for="funnel-other-health-problems" style="margin-top: 15px;">Інші проблеми (необов'язково):</label>
                <textarea id="funnel-other-health-problems" class="funnel-input" rows="3"></textarea>
            `,
      onRender: () => {
        // НОВА ФУНКЦІЯ: Викликаємо рендеринг нашого нового списку
        renderHealthProblemsChecklist(
          funnelManager.state.registrationData.health_problems || []
        );
      },
      validate: (data) => {
        // ОНОВЛЕНА ЛОГІКА: Збираємо дані з чекбоксів
        const checkedCheckboxes = document.querySelectorAll(
          '#funnel-health-problems-list input[type="checkbox"]:checked'
        );
        data.health_problems = Array.from(checkedCheckboxes).map(
          (checkbox) => checkbox.value
        );

        const otherProblemsEl = document.getElementById(
          'funnel-other-health-problems'
        );
        data.other_health_problems = otherProblemsEl
          ? otherProblemsEl.value.trim()
          : '';
        return true;
      },
    },
    {
      id: 'excluded_exercises',
      title: 'Виключені вправи',
      subtitle: "(не обов'язково)",
      fields: ['excluded_exercises'],
      render: () => `
                <p class="step-description">Оберіть вправи 🏋️, які потрібно виключити. Ми не будемо використовувати їх при генерації вашого плану. Ви зможете змінити це пізніше в профілі, але тоді перша програма може містити небажані для вас вправи.</p>
                <div id="funnel-excluded-exercises-container">Завантаження доступних вправ...</div>
            `,
      // ЗМІНЕНО: Тепер onRender передає збережені дані у функцію
      onRender: () => {
        funnel_loadAndRenderExcludedExercises(
          funnelManager.state.registrationData.excluded_exercises || []
        );
      },
      validate: (data) => {
        const checkedCheckboxes = document.querySelectorAll(
          '#funnel-excluded-exercises-container input[type="checkbox"]:checked'
        );
        data.excluded_exercises = Array.from(checkedCheckboxes).map(
          (checkbox) => checkbox.value
        );
        return true;
      },
    },
    {
      id: 'full_name',
      title: "Ваше Ім'я та Прізвище",
      fields: ['full_name'],
      render: () => `
                <p class="step-description">Ці дані потрібні для адмін. питань, вони не будуть відображатися іншим користувачам.</p>
                <input type="text" id="funnel-full-name" class="funnel-input" placeholder="Наприклад: Максим Василенко" required>
            `,
      validate: (data) => {
        const element = document.getElementById('funnel-full-name');
        data.full_name = element ? element.value.trim() : '';
        if (!data.full_name)
          return "Будь ласка, вкажіть ваше Ім'я та Прізвище.";
        return true;
      },
    },
    {
      id: 'display_name',
      title: "Публічне ім'я або псевдонім",
      subtitle: "(не обов'язково)",
      fields: ['display_name'],
      render: () => `
                <p class="step-description">Це ім'я буде відображатися в рейтингах та спільноті. Якщо залишити поле порожнім, ваш профіль буде анонімним.</p>
                <input type="text" id="funnel-display-name" class="funnel-input" placeholder="Наприклад: MaxPower">
            `,
      async validate(data) {
        // <-- Функція стала 'async'
        const element = document.getElementById('funnel-display-name');
        data.display_name = element ? element.value.trim() : '';

        // Якщо користувач ввів ім'я, перевіряємо його на унікальність
        if (data.display_name) {
          try {
            const response = await fetch(`${baseURL}/check-display-name`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ display_name: data.display_name }),
            });
            const result = await response.json();
            if (!response.ok || !result.is_available) {
              return "Це публічне ім'я вже зайнято. Спробуйте будь ласка інше.";
            }
          } catch (error) {
            return "Не вдалося перевірити публічне ім'я. Поганий Інтернет-зв'язок.";
          }
        }
        return true; // Якщо поле порожнє або ім'я доступне
      },
    },
    {
      id: 'socials',
      title: 'Посилання на соцмережі',
      subtitle: "(не обов'язково)",
      fields: ['instagram_link', 'telegram_link'],
      render: () => `
                <p class="step-description">Додайте посилання, щоб інші користувачі могли з вами зв'язатись 👋</p>
                <label for="funnel-instagram-link">Instagram:</label>
                <input type="text" id="funnel-instagram-link" class="funnel-input" placeholder="Ваш нікнейм або посилання">
                <label for="funnel-telegram-link">Telegram:</label>
                <input type="text" id="funnel-telegram-link" class="funnel-input" placeholder="Ваш @username або посилання">
            `,
      validate: (data) => {
        const instaEl = document.getElementById('funnel-instagram-link');
        const teleEl = document.getElementById('funnel-telegram-link');
        data.instagram_link = instaEl ? instaEl.value.trim() : '';
        data.telegram_link = teleEl ? teleEl.value.trim() : '';
        return true;
      },
    },
    {
      id: 'phone',
      title: 'Ваш номер телефону',
      fields: ['phone'],
      render: () => `
                <p class="step-description">Він буде вашим логіном для входу в особистий кабінет. Дані повністю конфіденційні ✅</p>
                <input type="tel" id="funnel-phone" class="funnel-input" placeholder="380 XX XXX XX XX" required>
            `,
      async validate(data) {
        // <-- Функція стала 'async'
        const element = document.getElementById('funnel-phone');
        data.phone = element ? element.value.trim() : '';

        // Спочатку базова перевірка
        if (!data.phone || data.phone.length < 10) {
          return 'Введіть коректний номер телефону.';
        }

        // Перевіряємо номер на унікальність
        try {
          const response = await fetch(`${baseURL}/check-phone`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: data.phone }),
          });
          const result = await response.json();
          if (!response.ok || !result.is_available) {
            return 'Цей номер телефону вже зареєстровано. Спробуйте будь ласка інший.';
          }
        } catch (error) {
          return "Не вдалося перевірити номер. Поганий Інтернет-зв'язок.";
        }
        return true; // Якщо все добре
      },
    },
    {
      id: 'password',
      title: 'Створіть надійний пароль',
      fields: ['password'],
      render: () => `
                <p class="step-description">Мінімум 8 символів. Використовуйте літери та цифри.</p>
                <label for="funnel-password">Пароль:</label>
                <input type="password" id="funnel-password" class="funnel-input" minlength="8" required>
                <label for="funnel-password-confirm">Підтвердіть пароль:</label>
                <input type="password" id="funnel-password-confirm" class="funnel-input" minlength="8" required>
            `,
      validate: (data) => {
        const pass = document.getElementById('funnel-password').value;
        const confirmPass = document.getElementById(
          'funnel-password-confirm'
        ).value;
        if (pass.length < 8) return 'Пароль має містити щонайменше 8 символів.';
        if (pass !== confirmPass) return 'Паролі не співпадають.';
        data.password = pass;
        return true;
      },
    },
    {
      id: 'email',
      title: 'Вкажіть ваш email',
      subtitle: "(не обов'язково)",
      fields: ['email'],
      render: () => `
                <p class="step-description">
                    Можливо вказати іншим разом. Проте, зробивши це зараз, ви зможете <strong>відновити доступ</strong> до акаунту, якщо забудете пароль. 🔑
                </p>
                <input type="email" id="funnel-email" class="funnel-input" placeholder="example@gmail.com">
            `,
      // Зверни увагу, що функція async, бо ми робимо запит до сервера
      async validate(data) {
        const element = document.getElementById('funnel-email');
        const email = element ? element.value.trim() : '';
        data.email = email; // Зберігаємо email у будь-якому випадку

        // Якщо поле порожнє, це нормально, бо воно не обов'язкове
        if (!email) {
          return true;
        }

        // Перевірка формату email на фронтенді
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          return 'Будь ласка, введіть коректний email.';
        }

        // Асинхронна перевірка унікальності на бекенді
        try {
          const response = await fetch(`${baseURL}/check-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email }),
          });
          const result = await response.json();
          if (!response.ok || !result.is_available) {
            return 'Цей email вже використовується. Спробуйте інший.';
          }
        } catch (error) {
          return "Не вдалося перевірити email. Перевірте з'єднання з Інтернетом.";
        }

        // Якщо всі перевірки пройдено
        return true;
      },
    },
    {
      id: 'confirmation',
      title: 'Майже готово!',
      fields: [], // Цей крок не збирає дані
      render: () => `
                <p class="step-description">
                    Чудово! Ви надали всю необхідну інформацію 🎉
                </p>
                <p class="step-description">
                    Натисніть кнопку нижче, щоб створити свій акаунт і отримати перший персональний тренувальний план✨
                </p>
                <div style="text-align: center; margin-bottom: -10px;">
                    <img 
                        src="https://limaxsport.top/registration/1.gif"
                        alt="Вітальна анімація" 
                        style="max-width: 100%; height: auto; border-radius: 5px;"
                    >
                </div>
            `,
      validate: () => {
        // Перевіряти нічого не потрібно, просто дозволяємо реєстрацію
        return true;
      },
    },
  ],

  init() {
    this.elements = {
      overlay: document.getElementById('funnel-overlay'),
      modal: document.getElementById('funnel-modal'),
      title: document.getElementById('funnel-step-title'),
      subtitle: document.getElementById('funnel-step-subtitle'),
      content: document.getElementById('funnel-step-content'),
      backBtn: document.getElementById('funnel-back-btn'),
      nextBtn: document.getElementById('funnel-next-btn'),
      statusMsg: document.getElementById('funnel-status-message'),
    };

    if (!this.elements.overlay) {
      console.error('Помилка ініціалізації: відсутній #funnel-overlay.');
      return;
    }

    this.elements.nextBtn.addEventListener('click', () =>
      this.handleNextStep()
    );
    this.elements.backBtn.addEventListener('click', () =>
      this.handlePrevStep()
    );
  },

  start() {
    if (!this.elements.overlay) return;
    this.state.currentStepIndex = 0;
    this.state.registrationData = {};

    // --- ДОДАНО: Створюємо унікальний ID для цієї сесії воронки ---
    this.state.funnelSessionId =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).substring(2);
    // --- КІНЕЦЬ ЗМІНИ ---

    this.elements.overlay.style.display = 'flex';
    this.renderCurrentStep();
  },

  hide() {
    if (!this.elements.overlay) return;
    this.elements.overlay.style.display = 'none';
  },

  // Знайди і заміни всю функцію renderCurrentStep на цю:
  renderCurrentStep() {
    const step = this.steps[this.state.currentStepIndex];
    if (!step) return;

    // --- ДОДАНО: Аналітика перегляду кроку ---
    trackFunnelEvent(step.id, 'step_view');

    // --- Фінальна логіка для прогрес-бару ---
    const fillElement = document.getElementById('funnel-progress-fill');
    if (fillElement) {
      const totalSteps = this.steps.length;
      const currentStepNumber = this.state.currentStepIndex + 1;
      const progressPercentage = (currentStepNumber / totalSteps) * 100;

      // Просто встановлюємо ширину. Решту зробить CSS.
      fillElement.style.width = progressPercentage + '%';
    }
    // --- Кінець блоку ---

    // --- ОНОВЛЕНА ЛОГІКА ДЛЯ ЗАГОЛОВКА І ПІДЗАГОЛОВКА ---
    // Важливо: використовуємо innerHTML, щоб працювали теги, якщо вони є
    this.elements.title.innerHTML = step.title;

    // Перевіряємо, чи є у кроку підзаголовок
    if (step.subtitle) {
      this.elements.subtitle.textContent = step.subtitle;
      this.elements.subtitle.style.display = 'block'; // Показуємо елемент
    } else {
      this.elements.subtitle.textContent = '';
      this.elements.subtitle.style.display = 'none'; // Ховаємо елемент
    }
    // --- КІНЕЦЬ ОНОВЛЕНОГО БЛОКУ ---

    // Додаємо клас, якщо це останній крок
    const isFirstStep = this.state.currentStepIndex === 0;
    const isLastStep = this.state.currentStepIndex === this.steps.length - 1;
    this.elements.modal.classList.toggle('is-first-step', isFirstStep);
    this.elements.modal.classList.toggle('is-final-step', isLastStep);

    const generatedHTML = step.render();
    this.elements.content.innerHTML = generatedHTML;

    if (step.onRender) {
      step.onRender();
    }

    this.elements.backBtn.style.display =
      this.state.currentStepIndex > 0 && !isLastStep ? 'block' : 'none';

    // ▼▼▼ ОНОВЛЕНА ЛОГІКА ДЛЯ ТЕКСТУ КНОПКИ ▼▼▼
    if (isLastStep) {
      this.elements.nextBtn.textContent = 'Зареєструватися';
    } else if (isFirstStep) {
      this.elements.nextBtn.textContent = 'Зробимо це! 🚀';
    } else {
      this.elements.nextBtn.textContent = 'Далі';
    }

    step.fields.forEach((field) => {
      const input = document.getElementById(
        `funnel-${field.replace(/_/g, '-')}`
      );
      if (input && this.state.registrationData[field]) {
        input.value = this.state.registrationData[field];
      }
    });
  },

  async handleNextStep() {
    const step = this.steps[this.state.currentStepIndex];

    this.elements.statusMsg.textContent = 'Перевірка...';
    this.elements.statusMsg.style.color = '#ccc';
    this.elements.nextBtn.disabled = true;

    // Запускаємо таймер. Якщо перевірка затягнеться, з'явиться повідомлення.
    loadingTimerManager.start(this.elements.statusMsg);

    const validationResult = await step.validate(this.state.registrationData);

    // Зупиняємо таймер, оскільки перевірка завершилась
    loadingTimerManager.stop();

    this.elements.nextBtn.disabled = false;

    if (validationResult !== true) {
      this.elements.statusMsg.textContent = validationResult;
      this.elements.statusMsg.style.color = 'red';
      return;
    }

    this.elements.statusMsg.textContent = '';

    if (this.state.currentStepIndex < this.steps.length - 1) {
      this.state.currentStepIndex++;
      this.renderCurrentStep();
    } else {
      this.handleFinalRegistration();
    }
  },

  handlePrevStep() {
    if (this.state.currentStepIndex > 0) {
      // --- Зберігаємо дані поточного кроку ---
      const currentStep = this.steps[this.state.currentStepIndex];
      if (currentStep && typeof currentStep.validate === 'function') {
        // Викликаємо validate, щоб зберегти дані, але ігноруємо результат (помилку валідації),
        // оскільки ми просто повертаємось назад, а не перевіряємо крок.
        currentStep.validate(this.state.registrationData);
      }

      this.state.currentStepIndex--;
      this.renderCurrentStep();
    }
  },

  async handleFinalRegistration() {
    if (this.state.isSubmitting) return;

    this.state.isSubmitting = true;

    // --- ДОДАНО: Аналітика спроби реєстрації ---
    trackFunnelEvent('confirmation', 'register_attempt');

    const registerBtn = this.elements.nextBtn; // Створюємо коротку змінну для зручності
    this.elements.nextBtn.disabled = true;
    this.elements.nextBtn.textContent = 'Реєстрація...';

    this.elements.statusMsg.style.color = 'lightgreen';
    this.elements.statusMsg.textContent = 'Створюємо ваш акаунт та профіль...';

    try {
      // --- КРОК А: Збираємо ВСІ дані в один об'єкт ---
      const rawData = this.state.registrationData;

      const getIntValue = (val) =>
        val && !isNaN(parseInt(val)) ? parseInt(val, 10) : null;
      const getFloatValue = (val) =>
        val && !isNaN(parseFloat(val)) ? parseFloat(val) : null;
      const getStrValue = (val) => (val && val.trim() ? val.trim() : null);
      const getArrayValue = (val) => (val && val.length > 0 ? val : null);

      const combinedDataForAPI = {
        // Дані для реєстрації
        phone: getStrValue(rawData.phone),
        password: getStrValue(rawData.password),
        email: getStrValue(rawData.email),

        // Дані для профілю
        full_name: getStrValue(rawData.full_name),
        display_name: getStrValue(rawData.display_name),
        age: getIntValue(rawData.age),
        weight: getFloatValue(rawData.weight),
        height: getIntValue(rawData.height),
        gender: getStrValue(rawData.gender),
        goal: getStrValue(rawData.goal),
        daytime_activity: getStrValue(rawData.daytime_activity),
        type_of_training: getStrValue(rawData.type_of_training),
        level_of_training: getStrValue(rawData.level_of_training),
        training_days_per_week: getIntValue(rawData.training_days_per_week),
        health_problems: getArrayValue(rawData.health_problems),
        other_health_problems: getStrValue(rawData.other_health_problems),
        excluded_exercises: getArrayValue(rawData.excluded_exercises),
        instagram_link: getStrValue(rawData.instagram_link),
        telegram_link: getStrValue(rawData.telegram_link),
        preferred_exercise_gender: getStrValue(
          rawData.preferred_exercise_gender
        ),
      };

      // --- КРОК Б: Робимо ОДИН запит ---
      const response = await fetch(`${baseURL}/register-self`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(combinedDataForAPI),
      });

      const responseData = await response.json();
      if (!response.ok) {
        // Якщо помилка, прокидаємо її для блоку catch
        throw new Error(responseData.detail || 'Помилка реєстрації');
      }

      // --- КРОК В: Зберігаємо токени одразу, вони потрібні для перевірки
      setTokens(
        responseData.access_token,
        responseData.refresh_token,
        responseData.expires_in
      );

      localStorage.setItem(
        'newUserJourneyMarker',
        JSON.stringify({ timestamp: Date.now() })
      );

      // Запускаємо наш зворотний відлік на 30 секунд
      this.startFinalCountdown(30);
      // Паралельно запускаємо перевірку готовності плану
      pollForPlanAndRedirect();
    } catch (error) {
      // ПОМИЛКА: Зупиняємо наш таймер зворотного відліку, якщо він був запущений
      this.clearFinalCountdown();

      const errorMessage = error.message || 'Сталася невідома помилка.';
      let errorHandled = false;

      if (errorMessage.includes('номер телефону')) {
        const phoneStepIndex = this.steps.findIndex(
          (step) => step.id === 'phone'
        );
        if (phoneStepIndex !== -1) {
          this.state.currentStepIndex = phoneStepIndex;
          this.renderCurrentStep();
          this.elements.statusMsg.textContent = errorMessage;
          this.elements.statusMsg.style.color = 'red';
          errorHandled = true;
        }
      } else if (
        errorMessage.includes("Публічне ім'я") ||
        errorMessage.includes('псевдонім')
      ) {
        const displayNameStepIndex = this.steps.findIndex(
          (step) => step.id === 'display_name'
        );
        if (displayNameStepIndex !== -1) {
          this.state.currentStepIndex = displayNameStepIndex;
          this.renderCurrentStep();
          this.elements.statusMsg.textContent = errorMessage;
          this.elements.statusMsg.style.color = 'red';
          errorHandled = true;
        }
      }

      if (!errorHandled) {
        this.elements.statusMsg.style.color = 'red';
        this.elements.statusMsg.textContent = `Помилка: ${errorMessage}`;
      }

      this.state.isSubmitting = false;
      this.elements.nextBtn.disabled = false;
      this.elements.nextBtn.textContent = 'Зареєструватися';
    }
  },

  /**
   * Запускає візуальний зворотний відлік на кнопці та у статусі.
   * @param {number} duration - Тривалість у секундах.
   */
  startFinalCountdown(duration) {
    this.clearFinalCountdown(); // Очищуємо попередній таймер, якщо він був

    const registerBtn = this.elements.nextBtn;
    const statusMsg = this.elements.statusMsg;
    let remaining = duration;

    const updateTimer = () => {
      if (remaining <= 0) {
        this.clearFinalCountdown();
        // Таймер завершився, але pollForPlanAndRedirect продовжує працювати
        // (він має власний таймаут на 100 секунд).
        // Просто залишаємо повідомлення про очікування.
        statusMsg.textContent = 'Майже готово, очікуємо відповідь...';
        registerBtn.textContent = 'Очікуємо...';
      } else {
        statusMsg.textContent = `Генерація плану... Залишилось: ${remaining} сек.`;
        registerBtn.textContent = `Зачекайте... ${remaining}`;
        remaining--;
      }
    };

    updateTimer(); // Викликаємо одразу, щоб не чекати першу секунду
    this.state.countdownTimerId = setInterval(updateTimer, 1000);
  },

  /**
   * Зупиняє та очищує активний таймер зворотного відліку.
   */
  clearFinalCountdown() {
    if (this.state.countdownTimerId) {
      clearInterval(this.state.countdownTimerId);
      this.state.countdownTimerId = null;
    }
  },
};

/**
 * Періодично перевіряє, чи згенерувався план, і тільки потім перенаправляє.
 */
function pollForPlanAndRedirect() {
  const statusElement = funnelManager.elements.statusMsg;
  let attempts = 0;
  const maxAttempts = 40; // Макс. спроб (40 * 5 сек = 200 секунд)

  const intervalId = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(intervalId);
      if (statusElement) {
        statusElement.textContent =
          'Не вдалося дочекатися генерації. Перенаправляємо...';
      }
      // Все одно перенаправляємо, навіть якщо не дочекалися
      window.location.href =
        'https://limaxsport.com/test/personal_cabinet#plan';
      return;
    }

    try {
      // Використовуємо fetchWithAuth, оскільки токени вже встановлені
      const { data: plans, response } = await fetchWithAuth(
        `${baseURL}/my-workout-plans`
      );

      // Якщо запит успішний і масив планів не порожній
      if (response.ok && Array.isArray(plans) && plans.length > 0) {
        clearInterval(intervalId);

        // --- ДОДАНО: Аналітика УСПІШНОЇ реєстрації та генерації ---
        trackFunnelEvent('confirmation', 'register_success');

        if (statusElement) {
          statusElement.textContent = 'План готовий! Перенаправляємо...';
        }
        setTimeout(() => {
          window.location.href =
            'https://limaxsport.com/test/personal_cabinet#plan';
        }, 1000); // Невелика затримка, щоб користувач побачив повідомлення
      }
    } catch (error) {
      // Ігноруємо помилки, просто спробуємо ще раз
      console.warn(
        `Спроба ${attempts}: План ще не готовий або помилка запиту.`
      );
    }
  }, 5000); // Перевіряємо кожні 5 секунд
}

// Проблеми зі здоров'ям
function renderHealthProblemsChecklist(userSelectedProblems = []) {
  const container = document.getElementById('funnel-health-problems-list');
  if (!container) return;

  container.innerHTML = ''; // Очищуємо контейнер

  const healthProblems = [
    { value: 'knees', label: 'Колінні суглоби' },
    { value: 'spine', label: 'Хребет (поперековий відділ)' },
    { value: 'hips', label: 'Тазостегнові суглоби' },
    { value: 'shoulder', label: 'Плечові суглоби' },
    { value: 'heart', label: 'Серцево-судинна система' },
    { value: 'breath', label: 'Захворювання дихальної системи' },
  ];

  healthProblems.forEach((problem, index) => {
    const checkboxId = `health-problem-${index}`;

    const labelElement = document.createElement('label');
    labelElement.className = 'health-problem-option';
    labelElement.setAttribute('for', checkboxId);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = checkboxId;
    checkbox.value = problem.value;
    checkbox.checked = userSelectedProblems.includes(problem.value);

    labelElement.appendChild(checkbox);
    labelElement.appendChild(document.createTextNode(` ${problem.label}`));
    container.appendChild(labelElement);
  });

  // --- НОВИЙ БЛОК: Перевірка, чи потрібна стрілка скролу ---
  // Даємо браузеру мить на рендеринг, щоб розміри були правильними
  setTimeout(() => {
    if (container.scrollHeight > container.clientHeight) {
      container.classList.add('is-scrollable');
    } else {
      container.classList.remove('is-scrollable');
    }
  }, 100);
}

// Виключені вправи
async function funnel_loadAndRenderExcludedExercises(userExcludedNames = []) {
  const container = document.getElementById(
    'funnel-excluded-exercises-container'
  );
  if (!container) return;

  container.innerHTML = '<p>Завантаження...</p>';

  const tempStatusElement = {
    set textContent(value) {
      container.innerHTML = `<p>${value}</p>`;
    },
    get textContent() {
      return container.textContent;
    },
    style: { color: '' },
  };
  loadingTimerManager.start(tempStatusElement);

  try {
    const genderChoice = funnelManager.state.registrationData.gender;
    const preferredGender =
      funnelManager.state.registrationData.preferred_exercise_gender;

    // Створюємо параметри для URL
    const params = new URLSearchParams();
    if (genderChoice) {
      params.append('gender', genderChoice);
    }
    if (preferredGender) {
      params.append('preferred_exercise_gender', preferredGender);
    }

    // Якщо параметрів немає, не робимо запит
    if (!params.toString()) {
      container.innerHTML =
        '<p style="color:orange;">Будь ласка, поверніться до попередніх кроків та зробіть вибір статі.</p>';
      loadingTimerManager.stop();
      return;
    }

    // Робимо запит з новими параметрами
    const { data: exercises, response } = await fetchWithAuth(
      `${baseURL}/self-registration/exercises?${params.toString()}`
    );

    if (!response.ok) {
      throw new Error(
        exercises?.detail || 'Не вдалося завантажити список вправ.'
      );
    }

    // Успіх! Зупиняємо таймер, оскільки дані завантажено
    loadingTimerManager.stop();
    container.innerHTML = '';

    if (!exercises || exercises.length === 0) {
      container.innerHTML = '<p>Доступні вправи для виключення відсутні.</p>';
      return;
    }

    const userTrainingType =
      funnelManager.state.registrationData.type_of_training;

    let filteredExercises;
    if (userTrainingType === 'home') {
      filteredExercises = exercises.filter(
        (exercise) => exercise.type === 'home' || exercise.type === 'both'
      );
    } else {
      filteredExercises = exercises;
    }

    if (filteredExercises.length === 0) {
      container.innerHTML =
        '<p>Немає вправ для виключення, що відповідають вашому вибору місця тренувань.</p>';
      return;
    }

    const sortedExercises = [...filteredExercises].sort((a, b) => {
      const isAExcluded = userExcludedNames.includes(a.name);
      const isBExcluded = userExcludedNames.includes(b.name);
      if (isAExcluded && !isBExcluded) return -1;
      if (!isAExcluded && isBExcluded) return 1;
      return a.name.localeCompare(b.name);
    });

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Пошук вправи... 🔍';
    searchInput.className = 'excluded-exercise-search-input';
    container.appendChild(searchInput);

    const listWrapper = document.createElement('div');
    listWrapper.className = 'excluded-exercise-list-wrapper';
    container.appendChild(listWrapper);

    sortedExercises.forEach((exercise, index) => {
      const gifName = exercise.name;
      const checkboxId = `exclude-gif-funnel-${index}`;
      const label = document.createElement('label');
      label.className = 'excluded-exercise-option';
      label.setAttribute('for', checkboxId);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = checkboxId;
      checkbox.value = gifName;
      checkbox.checked = userExcludedNames.includes(gifName);
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(` ${gifName}`));
      listWrapper.appendChild(label);
    });

    searchInput.addEventListener('input', (event) => {
      const searchTerm = event.target.value.toLowerCase();
      const allLabels = listWrapper.querySelectorAll(
        '.excluded-exercise-option'
      );
      allLabels.forEach((label) => {
        const exerciseName = label.textContent.toLowerCase();
        if (exerciseName.includes(searchTerm)) {
          label.style.display = 'block';
        } else {
          label.style.display = 'none';
        }
      });
    });

    setTimeout(() => {
      if (listWrapper.scrollHeight > listWrapper.clientHeight) {
        listWrapper.classList.add('is-scrollable');
      } else {
        listWrapper.classList.remove('is-scrollable');
      }
    }, 100);
  } catch (error) {
    // Помилка! Зупиняємо таймер і показуємо повідомлення про помилку
    loadingTimerManager.stop();
    console.error('Помилка завантаження вправ для воронки:', error);
    container.innerHTML = `<p style="color:red;">Помилка: ${error.message}</p>`;
  }
}

// --- ЧАСТИНА 3: НАДІЙНИЙ ЗАПУСК ЛОГІКИ ---

function initializeFunnel() {
  funnelManager.init();
  funnelManager.start();
}

// Надійна перевірка готовності DOM
if (
  document.readyState === 'complete' ||
  document.readyState === 'interactive'
) {
  // Якщо сторінка вже завантажена, запускаємо код негайно
  initializeFunnel();
} else {
  // Інакше, чекаємо на стандартну подію
  document.addEventListener('DOMContentLoaded', initializeFunnel);
}

/*
// ==========================================================
// === КОД ДЛЯ МОБІЛЬНОЇ КОНСОЛІ v2.0 (самодостатній) ===
// ==========================================================
(function() {
    // Не створювати консоль двічі
    if (document.getElementById('mobile-console-v2')) return;

    // Створюємо головний div
    const consoleDiv = document.createElement('div');
    consoleDiv.id = 'mobile-console-v2';
    document.body.appendChild(consoleDiv);

    // Створюємо та додаємо стилі динамічно
    const styles = `
        #mobile-console-v2 {
            position: fixed; bottom: 0; left: 0; width: 100%;
            max-height: 25%; overflow-y: auto; background-color: rgba(0, 0, 0, 0.85);
            border-top: 2px solid #ffc107; color: white; font-family: monospace;
            font-size: 12px; padding: 5px; z-index: 99999; box-sizing: border-box;
            display: flex; flex-direction: column-reverse;
        }
        #mobile-console-v2 pre {
            margin: 2px 0; padding: 3px; white-space: pre-wrap;
            word-break: break-all; border-bottom: 1px solid #444;
        }
        #mobile-console-v2 .log-error { color: #ff8a8a; }
        #mobile-console-v2 .log-warn { color: #ffc107; }
        #mobile-console-v2 .log-info { color: #8ab4f8; }
        #mobile-console-v2 .log-log { color: #e0e0e0; }
    `;
    const styleSheet = document.createElement("style");
    styleSheet.innerText = styles;
    document.head.appendChild(styleSheet);

    function createLogEntry(message, className) {
        const pre = document.createElement('pre');
        pre.className = className;
        pre.textContent = message;
        consoleDiv.prepend(pre);
    }

    // Перехоплюємо console.log та alert
    const oldLog = console.log;
    console.log = function(...args) {
        oldLog.apply(console, args);
        createLogEntry(`LOG: ${args.join(' ')}`, 'log-log');
    };
    window.alert = function(message) {
        oldLog(`ALERT: ${message}`); // Показуємо alert в звичайній консолі
        createLogEntry(`ALERT: ${message}`, 'log-info'); // І в нашій мобільній
    };

    // Інші консольні методи
    const oldError = console.error;
    console.error = function(...args) {
        oldError.apply(console, args);
        createLogEntry(`ERROR: ${args.join(' ')}`, 'log-error');
    };
    window.onerror = function(message, source, lineno, colno, error) {
        createLogEntry(`FATAL ERROR: ${message} @ ${source.split('/').pop()}:${lineno}`, 'log-error');
    };
})();
// === КІНЕЦЬ КОДУ ДЛЯ МОБІЛЬНОЇ КОНСОЛІ ===
*/
