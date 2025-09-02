// ========== ГЛОБАЛЬНІ ЗМІННІ ТА НАЛАШТУВАННЯ ==========

const baseURL = 'https://limaxsport.top/testapi'; // Базовий URL API

// Кеш та поточний стан
let usersCache = null; // Кеш для списку користувачів
let selectedUserPhone = null; // Телефон обраного користувача
let currentAdminTab = null; // Назва поточної активної вкладки адмінки
let gifsCache = null; // Кеш для GIF файлів
let exerciseCounter = 0; // Лічильник для нумерації вправ
let adminListenersAttached = false; // прапорець для обробників
let currentEditingPlanId = null; // NEW: ID плану, який зараз редагується
let saveDraftTimeout = null;
const DRAFT_SAVE_DEBOUNCE_TIME = 1500; // 1.5 секунди затримки
let workoutToCopyData = null; // Тут будуть дані тренування для копіювання
let isCopyModeActive = false; // Прапорець, що вказує на активний режим копіювання
let subscriptionSubmitHandler;
let subscriptionStatusClickHandler;

// ========== NEW: Змінні для пагінації тренувань ==========
let currentWorkoutPage = 0;
const WORKOUTS_PER_PAGE = 10;
let totalWorkoutsAvailable = 0;
let isLoadingMoreWorkouts = false; // Прапорець для уникнення подвійних запитів

// Змінні для логіки оновлення токенів
let isRefreshing = false;
let failedQueue = [];

// NEW: Змінні та константи для проактивного оновлення
let proactiveAdminRefreshTimerId = null; // Унікальне ім'я для адмін-панелі
let adminAccessTokenExpiresAt = null; // Унікальне ім'я для адмін-панелі

const ADMIN_PROACTIVE_REFRESH_LEAD_TIME_MS = 2 * 60 * 1000; // 2 хвилини
const ADMIN_DEFAULT_ACCESS_TOKEN_LIFETIME_MS = 120 * 60 * 1000; // 120 хвилин (якщо expires_in не надано)
const ADMIN_RETRY_ATTEMPTS = 3;
const ADMIN_RETRY_INITIAL_DELAY_MS = 5000;
const ADMIN_RETRY_BACKOFF_FACTOR = 2;

// Опції для селектів (генеруємо один раз)
const repsOptionsWithPlaceholderHTML =
  '<option value="">--</option>' +
  Array.from(
    { length: 50 },
    (_, i) => `<option value="${i + 1}">${i + 1}</option>`
  ).join('');

const weightOptionsWithPlaceholderHTML =
  '<option value="">--</option>' +
  Array.from(
    { length: 300 },
    (_, i) => `<option value="${i + 1}">${i + 1} кг</option>`
  ).join(''); // Додав "кг" для ясності

// NEW: Опції для часу (наприклад, від 5 до 300 секунд з кроком 5)
const timeOptionsHTML = Array.from({ length: 60 }, (_, i) => {
  const seconds = (i + 1) * 5;
  return `<option value="${seconds}">${seconds} сек</option>`;
}).join('');
const timeOptionsWithPlaceholderHTML =
  '<option value="">--</option>' + timeOptionsHTML;

// --- IDs елементів для зручності ---
const adminWorkoutListViewId = 'admin-workout-list-view';
const adminWorkoutFormViewId = 'admin-workout-form-view';
const adminWorkoutDetailsViewId = 'admin-workout-details-view';
const adminWorkoutListId = 'admin-workout-list';
const adminWorkoutListStatusId = 'admin-workout-list-status';
const adminWorkoutDetailsExercisesId = 'admin-workout-details-exercises';
const adminWorkoutDetailsStatusId = 'admin-workout-details-status';

// ========== ФУНКЦІЇ РОБОТИ З ТОКЕНАМИ ==========

// Функція для обробки запитів, що очікують
const processAdminQueue = (error, token = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

// Функції для роботи з токенами в localStorage; setTokens тепер приймає expiresInSeconds
function setAdminTokens(accessToken, refreshToken, expiresInSeconds) {
  localStorage.setItem('access_token', accessToken); // Можна використовувати спільні ключі, якщо логіка розділена файлами
  if (refreshToken) {
    localStorage.setItem('refresh_token', refreshToken);
  }

  const now = new Date().getTime();
  if (expiresInSeconds) {
    adminAccessTokenExpiresAt = now + expiresInSeconds * 1000;
  } else {
    adminAccessTokenExpiresAt = now + ADMIN_DEFAULT_ACCESS_TOKEN_LIFETIME_MS;
    console.warn(
      'Admin: expires_in не надано, встановлено дефолтний час життя access token.'
    );
  }
  localStorage.setItem(
    'admin_access_token_expires_at',
    adminAccessTokenExpiresAt.toString()
  ); // Унікальний ключ

  console.log(
    `Admin Tokens set/updated. Access token expires at: ${new Date(adminAccessTokenExpiresAt).toLocaleString()}`
  );
  scheduleProactiveAdminTokenRefresh(); // Плануємо наступне проактивне оновлення
}

function getAdminAccessToken() {
  // Можна залишити getAccessToken, якщо файли розділені
  return localStorage.getItem('access_token');
}

function getAdminRefreshToken() {
  // Можна залишити getRefreshToken
  return localStorage.getItem('refresh_token');
}

// NEW: Функція для отримання часу закінчення admin access token
function getAdminAccessTokenExpiresAt() {
  const timestampStr = localStorage.getItem('admin_access_token_expires_at');
  return timestampStr ? parseInt(timestampStr, 10) : null;
}

// MODIFIED: clearTokens тепер очищує і таймер, і час закінчення
function clearAdminTokens() {
  // Перейменовано для ясності
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('admin_access_token_expires_at'); // NEW
  localStorage.removeItem('token');
  localStorage.removeItem('is_admin');
  localStorage.removeItem('admin_phone');
  document.cookie = 'token=; path=/; max-age=0; SameSite=Lax; Secure';

  if (proactiveAdminRefreshTimerId) {
    // NEW: Очищуємо таймер
    clearTimeout(proactiveAdminRefreshTimerId);
    proactiveAdminRefreshTimerId = null;
  }
  adminAccessTokenExpiresAt = null; // NEW
  isRefreshing = false;
  failedQueue = [];
  console.log('Admin Tokens and refresh timer cleared.');
}

// --- NEW: Логіка проактивного оновлення токена для Адмін-панелі ---

function scheduleProactiveAdminTokenRefresh() {
  if (proactiveAdminRefreshTimerId) {
    clearTimeout(proactiveAdminRefreshTimerId);
    proactiveAdminRefreshTimerId = null;
  }

  const expiresAt = getAdminAccessTokenExpiresAt();
  if (!expiresAt || !getAdminRefreshToken()) {
    console.log(
      'Admin: Проактивне оновлення не заплановано (немає expiresAt або refresh token).'
    );
    return;
  }

  const now = new Date().getTime();
  let refreshInMs = expiresAt - now - ADMIN_PROACTIVE_REFRESH_LEAD_TIME_MS;

  if (refreshInMs < 5000) {
    // Якщо час вже близько або минув, спробувати через 5с
    refreshInMs = 5000;
    console.warn(
      `Admin: Час для планового оновлення токена вже близько/минув. Спроба через ${refreshInMs / 1000}с.`
    );
  }

  if (refreshInMs < 1000) {
    console.log(`Admin: Проактивне оновлення не заплановано (час < 1с).`);
    return;
  }

  console.log(
    `Admin: Наступне проактивне оновлення токена заплановано через: ${Math.round(refreshInMs / 1000)} секунд.`
  );
  proactiveAdminRefreshTimerId = setTimeout(
    handleProactiveAdminTokenRefresh,
    refreshInMs
  );
}

async function handleProactiveAdminTokenRefresh() {
  console.log('Admin: Спроба проактивного оновлення токена...');
  if (!getAdminRefreshToken()) {
    console.log('Admin: Проактивне оновлення скасовано (немає refresh token).');
    return;
  }
  if (isRefreshing) {
    console.log(
      'Admin: Проактивне оновлення відкладено (інший процес оновлення триває).'
    );
    return;
  }

  try {
    await performAdminTokenRefreshWithRetries();
  } catch (error) {
    console.error(
      'Admin: Проактивне оновлення токена остаточно не вдалося:',
      error
    );
    if (proactiveAdminRefreshTimerId) {
      clearTimeout(proactiveAdminRefreshTimerId);
      proactiveAdminRefreshTimerId = null;
    }
    if (
      error &&
      error.message &&
      error.message.toLowerCase().includes('invalid refresh token')
    ) {
      // Або інший текст помилки від вашого API
      console.warn(
        'Admin: Невалідний refresh token при проактивному оновленні. Вихід з системи.'
      );
      clearAdminTokens();
      showAdminLogin(); // Ваша функція для показу форми логіну адміна
      alert('Сесія адміністратора закінчилася. Будь ласка, увійдіть знову.');
    }
  }
}

async function performAdminTokenRefreshWithRetries() {
  if (isRefreshing) {
    return Promise.reject(new Error('Admin: Оновлення токенів вже триває.'));
  }
  isRefreshing = true;
  console.log(
    'Admin: Розпочато оновлення токенів (performAdminTokenRefreshWithRetries).'
  );
  // displayStatus('admin-session-status', 'Оновлення сесії...', false);

  try {
    const newTokens = await retryAdminOperation(
      async () => {
        // Використовуємо retryAdminOperation
        const refreshTokenValue = getAdminRefreshToken();
        if (!refreshTokenValue) {
          throw {
            ...new Error('Admin: No refresh token available for admin panel'),
            noRetry: true,
          };
        }
        console.log(
          'Admin: Виклик /refresh з токеном:',
          refreshTokenValue.substring(0, 10) + '...'
        );

        const response = await fetch(`${baseURL}/refresh`, {
          // Той самий ендпоінт /refresh
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshTokenValue }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({
            detail: `Admin: Помилка сервера при оновленні: ${response.status}`,
          }));
          if (
            response.status === 400 ||
            response.status === 401 ||
            (errorData.detail &&
              errorData.detail.toLowerCase().includes('invalid refresh token'))
          ) {
            throw {
              ...new Error(errorData.detail || 'Admin: Invalid refresh token'),
              noRetry: true,
            };
          }
          throw new Error(
            errorData.detail ||
              `Admin: Refresh failed with status ${response.status}`
          );
        }
        return response.json();
      },
      ADMIN_RETRY_ATTEMPTS,
      ADMIN_RETRY_INITIAL_DELAY_MS,
      ADMIN_RETRY_BACKOFF_FACTOR
    );

    console.log('Admin: Отримано нові токени:', newTokens);
    // Передаємо expires_in з відповіді сервера
    setAdminTokens(
      newTokens.access_token,
      newTokens.refresh_token,
      newTokens.expires_in
    );
    processAdminQueue(null, newTokens.access_token);
    return newTokens.access_token;
  } catch (error) {
    console.error(
      'Admin: Критична помилка після всіх спроб оновлення токена:',
      error
    );
    clearAdminTokens();
    showAdminLogin(); // Ваша функція для показу форми логіну адміна
    alert(
      'Не вдалося оновити сесію адміністратора. Будь ласка, увійдіть знову.'
    );
    processAdminQueue(error, null);
    throw error;
  } finally {
    isRefreshing = false;
    console.log('Admin: Завершено процес оновлення токенів.');
    // displayStatus('admin-session-status', '', false);
  }
}

// NEW: Універсальна функція для повторних спроб (можна зробити одну глобальну)
async function retryAdminOperation(
  operation,
  retries,
  delayMs,
  backoffFactor,
  attempt = 1
) {
  try {
    return await operation();
  } catch (error) {
    if (error.noRetry || attempt >= retries) {
      console.error(
        `Admin retryOperation: Остання спроба (${attempt}/${retries}) не вдалася або помилка не для ретраю.`,
        error.message
      );
      throw error;
    }
    console.warn(
      `Admin retryOperation: Спроба ${attempt}/${retries} не вдалася. Повтор через ${delayMs}ms. Помилка:`,
      error.message
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return retryAdminOperation(
      operation,
      retries,
      delayMs * backoffFactor,
      backoffFactor,
      attempt + 1
    );
  }
}

// ========== ДОПОМІЖНІ ФУНКЦІЇ ==========

/**
 * Форматує текст, замінюючи символи нового рядка на <br> для коректного відображення в HTML.
 * @param {string} text - Вхідний текст.
 * @returns {string} Відформатований HTML-рядок.
 */
function formatTextWithLineBreaks(text) {
  if (!text || typeof text !== 'string') {
    return ''; // Повертаємо порожній рядок, якщо текст відсутній
  }
  return text.replace(/\n/g, '<br>');
}

/**
 * Відображає статус повідомлення у вказаному елементі.
 * @param {string} elementId - ID елемента для відображення статусу.
 * @param {string} message - Текст повідомлення.
 * @param {boolean} isError - Чи є це повідомленням про помилку (для стилізації).
 * @param {number} clearAfterMs - Час у мс, після якого повідомлення зникне (0 - не зникатиме).
 */
function displayStatus(elementId, message, isError = false, clearAfterMs = 0) {
  const statusDiv = document.getElementById(elementId);
  if (statusDiv) {
    statusDiv.innerText = message;
    statusDiv.style.color = isError ? 'red' : 'lightgreen'; // Червоний для помилок, зелений для успіху/інфо
    if (clearAfterMs > 0) {
      setTimeout(() => {
        if (statusDiv.innerText === message) {
          // Очищаємо, тільки якщо повідомлення не змінилося
          statusDiv.innerText = '';
          statusDiv.style.color = 'white'; // Повертаємо стандартний колір
        }
      }, clearAfterMs);
    }
  } else {
    console.warn(`Елемент статусу з ID "${elementId}" не знайдено.`);
  }
}

/**
 * Обгортка для fetch API запитів з автоматичним оновленням токена.
 * Замінює стару функцію fetchAPI.
 */
async function fetchWithAuth(url, options = {}, statusElementId = null) {
  let token = getAdminAccessToken(); // Використовуємо функцію для адмін токена

  const headers = {
    ...options.headers,
    'Content-Type': options.headers?.['Content-Type'] || 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  let fetchOptions = { ...options, headers };

  if (statusElementId) displayStatus(statusElementId, 'Завантаження...');

  try {
    console.log(`fetchWithAuth (Admin): Запит до ${baseURL}${url}`);
    let response = await fetch(`${baseURL}${url}`, fetchOptions);

    if (response.status === 401 && getAdminRefreshToken()) {
      console.log('fetchWithAuth (Admin): Отримано 401.');
      if (!isRefreshing) {
        console.log(
          'fetchWithAuth (Admin): Запуск оновлення токена через 401.'
        );
        try {
          const newAccessToken = await performAdminTokenRefreshWithRetries();
          fetchOptions.headers['Authorization'] = `Bearer ${newAccessToken}`;
          console.log(
            `fetchWithAuth (Admin): Повторний запит до ${baseURL}${url} з новим токеном (після 401).`
          );
          response = await fetch(`${baseURL}${url}`, fetchOptions);
        } catch (refreshError) {
          console.error(
            'fetchWithAuth (Admin): Помилка оновлення токена після 401, запит не буде повторено.',
            refreshError
          );
          // showAdminLogin() та clearAdminTokens() вже викликані в performAdminTokenRefreshWithRetries
          throw refreshError;
        }
      } else {
        console.log(
          `fetchWithAuth (Admin): Оновлення вже триває, запит до ${baseURL}${url} додано до черги (після 401).`
        );
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((newAccessTokenFromQueue) => {
            fetchOptions.headers['Authorization'] =
              `Bearer ${newAccessTokenFromQueue}`;
            console.log(
              `fetchWithAuth (Admin): Повторний запит (з черги після 401) до ${baseURL}${url} з новим токеном.`
            );
            return fetch(`${baseURL}${url}`, fetchOptions);
          })
          .catch((err) => {
            console.error(
              `fetchWithAuth (Admin): Запит (з черги після 401) до ${baseURL}${url} не виконано через помилку оновлення.`
            );
            throw err;
          });
      }
    }

    const responseData = await response.json().catch((err) => {
      // Якщо тіло відповіді порожнє або не JSON, але статус ОК (наприклад, 204 No Content для DELETE)
      if (response.ok && response.status === 204) return null;
      // Якщо статус не ОК, але JSON не парситься, повертаємо текст помилки
      if (!response.ok)
        return response.text().then((text) => ({
          detail: text || `HTTP помилка ${response.status} без JSON тіла`,
        }));
      return null; // Для інших випадків
    });

    if (!response.ok) {
      const errorMessage =
        responseData?.detail || `HTTP помилка ${response.status}`;
      throw new Error(errorMessage);
    }

    if (statusElementId) displayStatus(statusElementId, '');
    return {
      data: responseData,
      headers: response.headers,
    };
  } catch (error) {
    console.error(
      `fetchWithAuth (Admin): Помилка під час запиту до ${baseURL}${url}:`,
      error
    );
    if (statusElementId)
      displayStatus(statusElementId, `Помилка: ${error.message}`, true);
    throw error;
  }
}

// -- Функція для створення модального вікна
function showCustomConfirmationDialogWithOptions(text, optionsHTML, onConfirm) {
  const overlay = document.getElementById('custom-confirm-overlay');
  const modal = document.getElementById('custom-confirm-modal-with-options');
  const textEl = document.getElementById('options-modal-text');
  const selectEl = document.getElementById('options-modal-select');
  const yesBtn = document.getElementById('options-modal-confirm-btn');
  const noBtn = document.getElementById('options-modal-cancel-btn');

  if (!overlay || !modal || !textEl || !selectEl || !yesBtn || !noBtn) {
    console.error('Елементи для модального вікна з опціями не знайдено!');
    return;
  }

  textEl.textContent = text;
  selectEl.innerHTML = optionsHTML;

  const closeModal = () => {
    overlay.style.display = 'none';
    modal.style.display = 'none';
  };

  yesBtn.replaceWith(yesBtn.cloneNode(true));
  noBtn.replaceWith(noBtn.cloneNode(true));

  document
    .getElementById('options-modal-confirm-btn')
    .addEventListener('click', () => {
      onConfirm(selectEl.value);
      closeModal();
    });
  document
    .getElementById('options-modal-cancel-btn')
    .addEventListener('click', closeModal);
  overlay.addEventListener('click', closeModal);

  overlay.style.display = 'block';
  modal.style.display = 'block';
}

/**
 * Перекладає значення полів профілю на українську.
 * @param {string} field - Назва поля (ключ у `translations`).
 * @param {string|string[]} value - Значення або масив значень.
 * @returns {string} Перекладене значення або оригінальне значення.
 */
function translateField(field, value) {
  // Словник перекладів (залишається без змін, як у вашому коді)
  const translations = {
    gender: {
      male: 'Чоловіча',
      female: 'Жіноча',
      not_applicable: 'Не застосовується',
    },
    goal: {
      'lose weight': 'схуднути',
      'gain muscle mass': "набрати м'язову масу",
      'maintain shape': 'підтримувати форму',
    },
    daytime_activity: { low: 'низька', average: 'середня', high: 'висока' },
    type_of_training: {
      gym: 'в залі',
      home: 'вдома/вулиця',
      both: 'комбіновані',
    },
    level_of_training: { low: 'низький', average: 'середній', high: 'високий' },
    health_problems: {
      knees: 'коліна',
      spine: 'хребет',
      hips: 'таз',
      shoulder: 'плечі',
      heart: 'серце',
      breath: 'дихання',
      other: 'інше',
    },
    excluded_exercises: { legs1: 'присідання', legs2: 'ікри', legs3: 'випади' },
    excluded_products: {
      milk: 'молоко',
      cottage_cheese: 'творог',
      yogurt: 'йогурт',
      sour_cream: 'сметана',
      cheese: 'сир',
      eggs: 'яйця',
      chicken: 'курка',
      turkey: 'індичка',
      pork: 'свинина',
      beef: 'яловичина',
      shank: 'шинка',
      offal: 'субпродукти',
      salted_fish: 'солона риба',
      cooked_fish: 'риба приготовлена',
      shrimps: 'креветки',
      squid: 'кальмари',
      caviar: 'ікра',
      cod_liver: 'печінка тріски',
      canned_fish: 'консервована риба',
      oatmeal: 'вівсянка',
      buckwheat: 'гречка',
      rice: 'рис',
      bulgur: 'булгур',
      pasta: 'макарони',
      spaghetti: 'спагетті',
      corn_grits: 'кукурудзяна крупа',
      quinoa: 'кіноа',
      couscous: 'кускус',
      semolina: 'манна крупа',
      pearl_barley: 'перлівка',
      millet: 'пшоно',
      barley_groats: 'ячна крупа',
      flakes: 'пластівці',
      potato: 'картопля',
      sweet_potato: 'батат',
      bread: 'хліб',
      pita: 'лаваш',
      tortilla: 'тортілья',
      breadsticks: 'хлібці',
      nuts: 'горіхи',
      peanut_butter: 'арахісова паста',
      peas: 'горох',
      lentils: 'сочевиця',
      beans: 'квасоля',
      butter: 'масло вершкове',
      olive: 'оливки',
      mushrooms: 'гриби',
      beet: 'буряк',
      onion: 'цибуля',
      tomatoes: 'помідори (томатна паста)',
      canned_vegetables: 'консервовані овочі',
      zucchini: 'кабачки',
      eggplants: 'баклажани',
      pumpkin: 'гарбуз',
      avocado: 'авокадо',
      banana: 'банани',
      apples: 'яблука',
      pears: 'груші',
      orange: 'апельсини',
      lemon: 'лимони',
      kiwi: 'ківі',
      strawberry: 'полуниця',
      dried_fruits: 'сухофрукти',
      jam: 'варення/джем',
      marshmallow: 'зефір',
      lukum: 'лукум',
      protein: 'протеїн (спортпіт)',
    },
    number_of_meals: { two: '2', three: '3', four: '4' },
    subscription_type: {
      weekly: 'Тиждень',
      monthly: 'Місяць',
      quarterly: '3 місяці',
      semi_annual: 'Півроку',
      annual: 'Рік',
    },
  };

  if (!translations[field])
    return Array.isArray(value) ? value.join(', ') : value; // Повертаємо як є, якщо перекладу немає

  if (Array.isArray(value)) {
    return (
      value.map((item) => translations[field][item] || item).join(', ') ||
      'не вказано'
    );
  } else if (value) {
    return translations[field][value] || value;
  } else {
    return 'не вказано';
  }
}

/**
 * Функція для автоматичної зміни висоти textarea.
 * @param {HTMLElement} textarea - Елемент textarea, висоту якого потрібно змінити.
 */
function autoResize(textarea) {
  // Перевіряємо, чи це дійсно елемент і чи є у нього властивість scrollHeight
  if (!textarea || typeof textarea.scrollHeight === 'undefined') {
    return;
  }
  // Тимчасово скидаємо висоту, щоб браузер міг коректно виміряти реальну висоту контенту
  textarea.style.height = 'auto';
  // Встановлюємо висоту, що дорівнює висоті прокрутки (вмісту) + 2px для уникнення "стрибання" скролбару
  textarea.style.height = textarea.scrollHeight + 2 + 'px';
}

/**
 * Ініціалізує авторесайз для всіх textarea з класом '.auto-resize-textarea'.
 * Обробляє як існуючі елементи, так і ті, що додаються динамічно.
 */
function initializeAutoResize() {
  const container = document.body; // Можна вказати більш конкретний контейнер, напр. document.getElementById('exercises-container')

  // 1. Застосовуємо до всіх існуючих textarea на сторінці
  const existingTextareas = container.querySelectorAll('.auto-resize-textarea');
  existingTextareas.forEach((textarea) => {
    // Встановлюємо початкову висоту і додаємо слухача
    autoResize(textarea);
    textarea.addEventListener('input', () => autoResize(textarea));
  });

  // 2. Створюємо "Спостерігача" (MutationObserver) для відслідковування нових елементів
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      // Перевіряємо, чи були додані нові вузли (елементи)
      if (mutation.addedNodes.length) {
        mutation.addedNodes.forEach((node) => {
          // Перевіряємо, чи є доданий вузол елементом (а не текстом)
          if (node.nodeType === 1) {
            // Шукаємо textarea всередині нового елемента (або якщо сам елемент є textarea)
            const newTextareas = node.matches('.auto-resize-textarea')
              ? [node]
              : node.querySelectorAll('.auto-resize-textarea');

            newTextareas.forEach((textarea) => {
              // Встановлюємо початкову висоту і додаємо слухача
              autoResize(textarea);
              textarea.addEventListener('input', () => autoResize(textarea));
            });
          }
        });
      }
    });
  });

  // 3. Запускаємо спостерігача
  observer.observe(container, {
    childList: true, // Спостерігати за додаванням/видаленням дочірніх елементів
    subtree: true, // Спостерігати у всіх нащадках контейнера
  });
}

// Запускаємо ініціалізацію, коли весь HTML-контент сторінки завантажився
document.addEventListener('DOMContentLoaded', initializeAutoResize);

// --- Додаємо функцію форматування секунд, якщо її немає ---
function formatSecondsToMMSS(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || totalSeconds <= 0)
    return '-';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// --- ФУНКЦІЇ КЕРУВАННЯ ВИДИМІСТЮ ---

/**
 * Показує форму логіну та ховає адмін-панель.
 * Очищує стан адмін-панелі та вміст вкладок.
 */
function showAdminLogin() {
  console.log('[UI] Показ форми логіну.'); // Лог для діагностики
  const loginOverlay = document.getElementById('login-overlay');
  const adminPanel = document.getElementById('admin-panel');
  const loginResponseDiv = document.getElementById('login-response');
  const loginForm = document.getElementById('login-form');

  // Показуємо оверлей входу, ховаємо адмін-панель
  if (loginOverlay) loginOverlay.style.display = 'flex';
  if (adminPanel) adminPanel.style.display = 'none';

  // Очищуємо повідомлення та поля форми логіну
  if (loginResponseDiv) loginResponseDiv.innerText = '';
  if (loginForm) loginForm.reset();

  // --- Очищуємо кеш та стан адмінки ---
  usersCache = null;
  selectedUserPhone = null;
  currentAdminTab = null; // Важливо скидати поточну вкладку
  gifsCache = null;
  exerciseCounter = 0;

  // --- Очищуємо/ховаємо вміст різних вкладок адмін-панелі ---

  // Вкладка "Профілі"
  const userListElement = document.getElementById('user-list');
  if (userListElement) {
    userListElement.innerHTML = '';
  }
  const profileDetailsElement = document.getElementById('profile-details');
  if (profileDetailsElement) {
    profileDetailsElement.style.display = 'none';
    // profileDetailsElement.innerHTML = ''; // Можна і вміст чистити, але display:none достатньо
  }
  const changePassMessageDiv = document.getElementById(
    'change_password-message'
  );
  if (changePassMessageDiv) {
    changePassMessageDiv.innerText = '';
  }

  // Вкладка "Прогрес"
  const progressDetailsElement = document.getElementById('progress-details');
  if (progressDetailsElement) {
    progressDetailsElement.style.display = 'none';
    const tbody = progressDetailsElement.querySelector('tbody');
    if (tbody) tbody.innerHTML = '';
  }

  // Вкладка "Тренування" (Очищення + Приховування нових блоків)
  const exercisesContainerElement = document.getElementById(
    'exercises-container'
  );
  if (exercisesContainerElement) {
    exercisesContainerElement.innerHTML = '';
  }
  const trainingFormElement = document.getElementById('add-training-plan-form');
  if (trainingFormElement) {
    trainingFormElement.reset();
  }
  const trainingMessageDiv = document.getElementById('training-plan-message');
  if (trainingMessageDiv) {
    trainingMessageDiv.innerText = '';
  }
  // Приховуємо три основні блоки вкладки "Тренування"
  const listView = document.getElementById(adminWorkoutListViewId); // Використовуємо константи ID
  if (listView) listView.style.display = 'none';

  const formView = document.getElementById(adminWorkoutFormViewId);
  if (formView) formView.style.display = 'none';

  const detailsView = document.getElementById(adminWorkoutDetailsViewId);
  if (detailsView) detailsView.style.display = 'none';

  // Вкладка "Реєстрація"
  const registerMessageDiv = document.getElementById('register-message');
  if (registerMessageDiv) {
    registerMessageDiv.innerText = '';
  }
  const registerFormElement = document.getElementById('register-form');
  if (registerFormElement) registerFormElement.reset(); // Скидаємо і цю форму
}

/**
 * Показує адмін-панель та ховає форму логіну.
 * Автоматично відкриває вкладку "Профілі".
 */
function showAdminPanelContent() {
  console.log('[UI] Показ адмін-панелі.');
  const loginOverlay = document.getElementById('login-overlay');
  const adminPanel = document.getElementById('admin-panel');

  if (loginOverlay) loginOverlay.style.display = 'none';
  if (adminPanel) {
    adminPanel.style.display = 'block';

    // --- Прив'язуємо обробники тільки ОДИН РАЗ ---
    if (!adminListenersAttached) {
      attachAdminPanelListeners();
      adminListenersAttached = true;
    }
  }
  window.scrollTo(0, 0);
}

// ========== ЛОГІКА АВТОРИЗАЦІЇ ТА ВИХОДУ ==========

/**
 * Обробляє відправку форми логіну адміністратора.
 */
async function handleAdminLogin(event) {
  event.preventDefault();
  const form = event.target;
  const responseDivId = 'login-response';
  displayStatus(responseDivId, 'Вхід...');

  const phone = form.elements['phone'].value;
  const password = form.elements['password'].value;
  const totpCode = form.elements['totp_code'].value;

  try {
    const response = await fetch(`${baseURL}/login_admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password, totp_code: totpCode }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || `HTTP помилка ${response.status}`);
    }

    // Передаємо expires_in до setAdminTokens
    setAdminTokens(data.access_token, data.refresh_token, data.expires_in);
    localStorage.setItem('is_admin', data.is_admin);
    const normalizedPhone = phone.startsWith('+') ? phone.substring(1) : phone;
    localStorage.setItem('admin_phone', normalizedPhone);

    if (data.is_admin) {
      displayStatus(
        responseDivId,
        'Вхід успішний! Вітаю командире =)',
        false,
        2000
      );
      showAdminPanelContent();
      // Перше завантаження даних для активної вкладки (наприклад, профілі)
      // openTab(null, 'profiles'); // Відкриваємо вкладку "Профілі" за замовчуванням
    } else {
      clearAdminTokens();
      displayStatus(responseDivId, 'Доступ заборонено (не адмін?).', true);
      showAdminLogin();
    }
  } catch (error) {
    console.error('Помилка входу адміна:', error);
    displayStatus(responseDivId, `Помилка: ${error.message}`, true);
  }
}

/**
 * Обробляє вихід з системи.
 */
async function handleLogout() {
  // ... (ваш код для confirm) ...
  if (!confirm('Ви дійсно хочете вийти з панелі керування?')) return;

  const token = getAdminAccessToken();
  const refreshTokenExists = !!getAdminRefreshToken();

  if (token && refreshTokenExists) {
    try {
      await fetchWithAuth('/logout', { method: 'POST' });
    } catch (error) {
      console.warn('Помилка під час запиту /logout (ігнорується):', error);
    }
  } else {
    console.log('Admin: Вихід без виклику бекенду (токени відсутні).');
  }

  clearAdminTokens(); // Використовуємо оновлену функцію
  alert('Ви успішно вийшли! Відпочивайте =)');
  showAdminLogin();
}

// --- NEW: Page Visibility API для Адмін-панелі ---
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    console.log('Admin: Вкладка стала видимою.');
    // Перевіряємо, чи користувач авторизований як адмін
    // (можна додати перевірку localStorage.getItem("is_admin") === "true")
    const adminToken = getAdminAccessToken(); // Використовуємо адмінську функцію
    if (adminToken) {
      const expiresAt = getAdminAccessTokenExpiresAt();
      const now = new Date().getTime();
      if (
        expiresAt &&
        expiresAt - now < ADMIN_PROACTIVE_REFRESH_LEAD_TIME_MS * 1.5
      ) {
        console.log(
          'Admin: Токен близький до закінчення або вже мав оновитися, спроба проактивного оновлення.'
        );
        handleProactiveAdminTokenRefresh();
      } else if (expiresAt) {
        console.log(
          `Admin: Токен ще дійсний, до закінчення: ${Math.round((expiresAt - now) / 1000)}с. Перепланування.`
        );
        scheduleProactiveAdminTokenRefresh();
      }
    }
  } else {
    console.log('Admin: Вкладка стала невидимою.');
  }
});

// ========== ЛОГІКА ВКЛАДОК ==========

/**
 * Перемикає активну вкладку та керує відображенням контенту.
 * @param {Event|null} event - Подія кліку (може бути null при програмному виклику).
 * @param {string} tabName - ID вкладки для відкриття.
 */
function openTab(event, tabName) {
  console.log(
    `[openTab] Спроба відкрити: ${tabName}, Поточний користувач: ${selectedUserPhone}`
  );

  // Перевірка, чи вкладка вже активна (щоб уникнути зайвих дій при повторному кліку)
  if (currentAdminTab === tabName && event?.type === 'click') {
    // Перевіряємо тип події
    console.log(
      `[openTab] Вкладка ${tabName} вже активна. Повторний клік ігнорується.`
    );
    return;
  }

  // Знаходимо всі елементи контенту та кнопки вкладок
  const tabs = document.querySelectorAll('#admin-panel .tab-content');
  const links = document.querySelectorAll('#admin-panel .tab-link');
  // Знаходимо специфічні блоки вкладки "Тренування"
  const listView = document.getElementById(adminWorkoutListViewId);
  const formView = document.getElementById(adminWorkoutFormViewId);
  const detailsView = document.getElementById(adminWorkoutDetailsViewId);

  // 1. Ховаємо ВЕСЬ контент вкладок
  tabs.forEach((tab) => (tab.style.display = 'none'));
  // 2. Ховаємо специфічні блоки вкладки "Тренування" (про всяк випадок)
  if (listView) listView.style.display = 'none';
  if (formView) formView.style.display = 'none';
  if (detailsView) detailsView.style.display = 'none';

  // 3. Знімаємо клас 'active' з усіх кнопок вкладок
  links.forEach((link) => link.classList.remove('active'));

  // 4. Знаходимо та показуємо поточний основний контейнер вкладки
  const currentTabElement = document.getElementById(tabName);
  if (currentTabElement) {
    console.log(
      `[openTab] Елемент #${tabName} знайдено. Встановлення display: block...`,
      currentTabElement
    );
    currentTabElement.style.display = 'block'; // Показуємо основний контейнер вкладки
    // Перевірка стилю після встановлення
    setTimeout(() => {
      console.log(
        `[openTab] Стиль display для #${tabName} ПІСЛЯ встановлення:`,
        window.getComputedStyle(currentTabElement).display
      );
    }, 0);
  } else {
    console.error(
      `[openTab] Помилка: Елемент вкладки з ID '${tabName}' НЕ знайдено!`
    );
    return; // Виходимо, якщо вкладка не знайдена
  }

  // 5. Активуємо поточну кнопку вкладки
  const targetButton = document.querySelector(
    `#admin-panel .tab-link[onclick*="'${tabName}'"]`
  );
  targetButton?.classList.add('active');

  // 6. Зберігаємо назву поточної активної вкладки
  currentAdminTab = tabName;

  // 7. Завантажуємо/відображаємо специфічний контент для вкладки
  switch (tabName) {
    case 'profiles':
      loadUserList(); // Завантажуємо список користувачів
      const profileDetailsDiv = document.getElementById('profile-details');
      // Показуємо деталі тільки якщо користувач обраний
      if (profileDetailsDiv)
        profileDetailsDiv.style.display = selectedUserPhone ? 'block' : 'none';
      break;
    case 'progress':
      const progressDetailsDiv = document.getElementById('progress-details');
      if (progressDetailsDiv) {
        progressDetailsDiv.style.display = 'block'; // Завжди показуємо блок прогресу
        if (selectedUserPhone) {
          loadProgressDetails(selectedUserPhone); // Завантажуємо дані, якщо є юзер
        } else {
          // Якщо користувач не обраний, показуємо повідомлення
          progressDetailsDiv.querySelector('h3').textContent =
            'Прогрес користувача';
          const tbody = progressDetailsDiv.querySelector('tbody');
          if (tbody)
            tbody.innerHTML =
              '<tr><td colspan="6">Будь ласка, оберіть користувача у вкладці "Профілі".</td></tr>';
        }
      }
      break;
    case 'workouts':
      // Тепер у нас є визначені listView, formView, detailsView
      const listContainer = document.getElementById(adminWorkoutListId);
      const listUserSpan = document.getElementById(
        'admin-workout-list-username'
      );
      const addBtn = document.getElementById('show-add-training-form-btn');

      // За замовчуванням показуємо список
      if (listView) listView.style.display = 'block';
      if (formView) formView.style.display = 'none';
      if (detailsView) detailsView.style.display = 'none';

      if (selectedUserPhone) {
        // Якщо користувач обраний
        loadAdminWorkoutList(selectedUserPhone); // Завантажуємо його список
      } else {
        // Якщо не обраний
        if (listContainer)
          listContainer.innerHTML =
            '<p>Будь ласка, оберіть користувача у вкладці "Профілі".</p>';
        if (listUserSpan) listUserSpan.textContent = '(Оберіть користувача)';
        if (addBtn) addBtn.style.display = 'none'; // Ховаємо кнопку "+ Додати"
      }
      break;

    case 'plans':
      const plansContainer = document.getElementById('plans');
      if (plansContainer) {
        if (selectedUserPhone) {
          // Якщо користувач обраний, завантажуємо його плани
          adminLoadAndDisplayWorkoutPlans(selectedUserPhone);
        } else {
          // Якщо ні, показуємо повідомлення-заглушку
          plansContainer.innerHTML =
            '<p>Будь ласка, оберіть користувача у вкладці "Профілі", щоб переглянути його плани.</p>';
        }
      }
      break;

    case 'register':
      // Додаткова логіка при відкритті вкладки реєстрації (якщо потрібна)
      break;
    case 'notifications':
      loadAndDisplayAdminNotifications(); // Завантажує та показує список повідомлень
      resetNotificationForm(); // Скидає форму до стану створення
      break;
    case 'analytics':
      loadAndDisplayAdminStats();
      break;
    case 'actions':
      // Вкладка статична, додаткових дій не потрібно
      break;
    case 'logout':
      // Вкладка виходу обробляється кнопкою всередині неї
      break;
  }
}

// ========== ЛОГІКА ВКЛАДКИ "РЕЄСТРАЦІЯ" ==========

/**
 * Обробляє відправку форми реєстрації нового користувача.
 */
async function handleRegisterSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const messageDivId = 'register-message';
  displayStatus(messageDivId, 'Реєстрація...');

  // Збираємо всі дані з форми, включаючи нове поле
  const requestBody = {
    phone: form.elements['phone-register'].value,
    is_admin: form.elements['is_admin'].checked,
    is_trainer: form.elements['is_trainer'].checked,
    registration_type: form.elements['registration_type'].value, // <-- ОСЬ ЗМІНА
  };

  try {
    const { data } = await fetchWithAuth(
      '/admin/users/register',
      {
        method: 'POST',
        body: JSON.stringify(requestBody), // Відправляємо оновлений об'єкт
      },
      messageDivId
    );

    displayStatus(
      messageDivId,
      `Реєстрація успішна! Пароль: ${data.generated_password}`,
      false
    );
    form.reset();
    usersCache = null;
  } catch (error) {
    console.error('Помилка реєстрації:', error);
  }
}

// === ПОЧАТОК БЛОКУ: ЛОГІКА ДЛЯ ПОВІДОМЛЕНЬ ===

/**
 * Завантажує та відображає всі повідомлення в адмін-панелі.
 * ЗМІНЕНО: Спрощено виклик displayStatus.
 */
async function loadAndDisplayAdminNotifications() {
  const container = document.getElementById('notifications-list-container');
  if (!container) return;

  container.innerHTML = '<p>Завантаження повідомлень...</p>';

  try {
    const { data: notifications } = await fetchWithAuth(`/notifications`);

    container.innerHTML = ''; // Очищуємо контейнер

    if (!notifications || notifications.length === 0) {
      container.innerHTML = '<p>Опублікованих повідомлень немає.</p>';
      return;
    }

    notifications.forEach((msg) => {
      const date = new Date(msg.created_at).toLocaleString('uk-UA', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      const itemDiv = document.createElement('div');
      itemDiv.className = 'notification-admin-item';
      itemDiv.dataset.id = msg.id;

      itemDiv.innerHTML = `
                <div class="notification-admin-actions">
                    <button class="edit-notification-btn" title="Редагувати">✏️</button>
                    <button class="delete-notification-btn" title="Видалити">🗑️</button>
                </div>
                <div class="notification-admin-header">
                    <h5 class="notification-admin-title"></h5>
                    <span class="notification-admin-date">${date}</span>
                </div>
                <p class="notification-admin-text"></p>
            `;

      itemDiv.querySelector('.notification-admin-title').textContent =
        msg.title;
      itemDiv.querySelector('.notification-admin-text').textContent = msg.text;

      itemDiv
        .querySelector('.edit-notification-btn')
        .addEventListener('click', () => {
          setupNotificationFormForEdit(msg);
        });

      itemDiv
        .querySelector('.delete-notification-btn')
        .addEventListener('click', () => {
          handleDeleteNotification(msg.id, msg.title);
        });

      container.appendChild(itemDiv);
    });
  } catch (error) {
    container.innerHTML = `<p style="color:red;">Помилка завантаження: ${error.message}</p>`;
    // ВИПРАВЛЕНО: Передаємо ID напряму
    displayStatus(
      'notification-status',
      `Помилка: ${error.message}`,
      true,
      5000
    );
  }
}

/**
 * Налаштовує форму для редагування існуючого повідомлення.
 * @param {object} notification - Об'єкт повідомлення.
 */
function setupNotificationFormForEdit(notification) {
  document.getElementById('notification-form-title').textContent =
    'Редагувати повідомлення';
  document.getElementById('notification-id').value = notification.id;
  document.getElementById('notification-title').value = notification.title;

  // ▼▼▼ ПОЧАТОК ЗМІН ▼▼▼
  const notificationTextarea = document.getElementById('notification-text');
  notificationTextarea.value = notification.text;
  autoResize(notificationTextarea); // Викликаємо autoResize для textarea
  // ▲▲▲ КІНЕЦЬ ЗМІН ▲▲▲

  document.getElementById('notification-submit-btn').textContent = 'Оновити';
  document.getElementById('notification-cancel-edit-btn').style.display =
    'inline-block';

  document
    .getElementById('notification-form')
    .scrollIntoView({ behavior: 'smooth' });
}

/**
 * Скидає форму до стану створення нового повідомлення.
 */
function resetNotificationForm() {
  document.getElementById('notification-form-title').textContent =
    'Створити нове повідомлення';
  document.getElementById('notification-form').reset(); // Очищує всі поля
  document.getElementById('notification-id').value = ''; // Очищує приховане поле ID
  document.getElementById('notification-submit-btn').textContent =
    'Опублікувати';
  document.getElementById('notification-cancel-edit-btn').style.display =
    'none';
}

/**
 * Обробник видалення повідомлення з підтвердженням.
 * ЗМІНЕНО: Спрощено виклик displayStatus.
 */
function handleDeleteNotification(id, title) {
  if (
    confirm(
      `Ви дійсно хочете видалити повідомлення "${title}"? Ця дія незворотня.`
    )
  ) {
    // ВИПРАВЛЕНО: Передаємо ID напряму, а не шукаємо елемент тут
    const statusDivId = 'notification-status';
    displayStatus(statusDivId, 'Видалення...', false);

    fetchWithAuth(`/admin/notifications/${id}`, { method: 'DELETE' })
      .then(() => {
        displayStatus(
          statusDivId,
          'Повідомлення успішно видалено.',
          false,
          3000
        );

        const itemToRemove = document.querySelector(
          `.notification-admin-item[data-id="${id}"]`
        );
        if (itemToRemove) {
          itemToRemove.remove();
        }
      })
      .catch((error) => {
        displayStatus(
          statusDivId,
          `Помилка видалення: ${error.message}`,
          true,
          5000
        );
      });
  }
}

/**
 * Обробник відправки форми (створення або оновлення).
 * ЗМІНЕНО: Спрощено виклик displayStatus.
 */
async function handleNotificationFormSubmit(event) {
  event.preventDefault(); // Залишаємо, це важливо

  // ВИПРАВЛЕНО: Передаємо ID напряму і не створюємо зайву змінну statusDiv
  const statusDivId = 'notification-status';
  const form = document.getElementById('notification-form');

  const id = form.elements['id'].value;
  const title = form.elements['title'].value;
  const text = form.elements['text'].value;

  const validationErrors = [];
  if (title.length <= 3) {
    validationErrors.push('Заголовок має містити більше 3 символів.');
  }
  if (text.length <= 10) {
    validationErrors.push('Текст повідомлення має містити більше 10 символів.');
  }

  if (validationErrors.length > 0) {
    displayStatus(statusDivId, validationErrors.join('\n'), true, 6000);
    return; // Зупиняємо виконання, якщо є помилки
  }

  const isEditing = !!id;
  const url = isEditing
    ? `/admin/notifications/${id}`
    : `/admin/notifications/new-notification`;
  const method = isEditing ? 'PUT' : 'POST';

  displayStatus(
    statusDivId,
    isEditing ? 'Оновлення...' : 'Публікація...',
    false
  );

  try {
    await fetchWithAuth(url, {
      method: method,
      // Додаємо заголовок, щоб бекенд знав, що ми надсилаємо JSON
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, text }),
    });

    displayStatus(
      statusDivId,
      isEditing ? 'Повідомлення оновлено!' : 'Повідомлення опубліковано!',
      false,
      3000
    );
    resetNotificationForm();
    loadAndDisplayAdminNotifications(); // Оновлюємо список
  } catch (error) {
    // Цей блок тепер безпечний, бо ми не використовуємо statusDiv.id
    displayStatus(statusDivId, `Помилка: ${error.message}`, true, 5000);
  }
}

// === КІНЕЦЬ БЛОКУ: ЛОГІКА ДЛЯ ПОВІДОМЛЕНЬ ===

// ========== ЛОГІКА ВКЛАДОК "ПРОФІЛІ" ТА "ПРОГРЕС" ==========

/**
 * Завантажує список користувачів з кешу або сервера.
 */
async function loadUserList() {
  const userListElement = document.getElementById('user-list');
  if (!userListElement) return;
  userListElement.innerHTML = '<li>Завантаження списку...</li>';
  console.log(
    `[loadUserList] Перевірка кешу. usersCache існує: ${!!usersCache}`
  ); // ЛОГ ДІАГНОСТИКИ

  try {
    if (!usersCache) {
      console.log('[loadUserList] Кеш порожній. Запит до API...');

      const response = await fetchWithAuth('/admin/users/list');
      usersCache = response.data; // Зберігаємо в кеш саме масив користувачів

      console.log('[loadUserList] Дані отримано з API:', usersCache);
      if (!usersCache) usersCache = [];
    } else {
      console.log('[loadUserList] Використання кешу.');
    }

    // Тепер в displayUserList передається саме масив, як і очікується
    displayUserList(usersCache);
  } catch (error) {
    userListElement.innerHTML = '<li>Помилка завантаження списку.</li>';
    usersCache = null;
  }
}

/**
 * Відображає список користувачів з урахуванням фільтру пошуку.
 * @param {Array} users - Масив користувачів.
 */
function displayUserList(users) {
  const userListElement = document.getElementById('user-list');
  const searchInput = document.getElementById('search-input');

  // Додаємо перевірку на існування елементів
  if (!userListElement) {
    console.error(
      '[displayUserList] КРИТИЧНО: Елемент #user-list НЕ ЗНАЙДЕНО!'
    );
    // Якщо елемента немає, відображати список неможливо.
    // Можливо, варто відобразити помилку прямо тут,
    // але поки що проблема в тому, що спрацьовує catch у loadUserList
    return; // Виходимо, якщо немає куди додавати список
  }
  if (!searchInput) {
    console.warn(
      '[displayUserList] Попередження: Елемент #search-input не знайдено.'
    );
    // Можна продовжувати без пошуку, але краще перевірити HTML
  }

  console.log(
    `[displayUserList] Відображення списку. Кількість користувачів (до фільтру): ${users?.length}. Пошук: "${searchInput?.value || ''}"`
  ); // Ваш існуючий лог

  // --- Початок фільтрації (додайте цей блок, якщо він у вас відрізняється) ---
  const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
  console.log(`[displayUserList] Пошуковий термін: "${searchTerm}"`); // Лог для перевірки
  const filteredUsers = users.filter((user) => {
    // Перевірка на існування полів перед викликом toLowerCase
    const phoneMatch =
      user.phone && user.phone.toLowerCase().includes(searchTerm);
    const nameMatch =
      user.full_name && user.full_name.toLowerCase().includes(searchTerm); // Важливо перевіряти full_name на існування!
    return phoneMatch || nameMatch;
  });
  console.log(
    `[displayUserList] Кількість користувачів (після фільтру): ${filteredUsers.length}`
  ); // Ваш існуючий лог (або додайте)
  // --- Кінець фільтрації ---

  userListElement.innerHTML = ''; // Очищуємо попередній вміст (наприклад, "Завантаження...")

  if (filteredUsers.length === 0) {
    console.log('[displayUserList] Користувачів після фільтрації не знайдено.');
    userListElement.innerHTML = '<li>Користувачів не знайдено.</li>';
    return;
  }

  console.log('[displayUserList] Починаємо цикл створення елементів списку...'); // Новий лог

  // Обгортаємо цикл в try...catch
  try {
    filteredUsers.forEach((user, index) => {
      // Логуємо кожного користувача перед обробкою
      console.log(
        `[displayUserList] Створюємо елемент для користувача #${index}:`,
        user
      );

      const li = document.createElement('li');
      li.classList.add('user-item'); // Додаємо базовий клас

      // Додаємо класи для ролей та статусу на сам <li> (для загальних стилів, як line-through)
      if (user.is_admin) li.classList.add('admin-user');
      if (user.is_trainer) li.classList.add('trainer-user');
      if (user.is_suspended) li.classList.add('suspended-user');

      // Очищуємо li перед додаванням нових елементів
      li.innerHTML = '';

      // --- Додаємо ПРЕФІКСИ у вигляді SPAN ---
      // Префікс статусу (якщо є)
      if (user.is_suspended) {
        const prefixSpan = document.createElement('span');
        prefixSpan.classList.add('role-prefix', 'suspended-prefix'); // Загальний і специфічний клас
        prefixSpan.textContent = '! '; // Текст префіксу (з пробілом)
        prefixSpan.title = 'Призупинено'; // Підказка при наведенні
        li.appendChild(prefixSpan); // Додаємо першим
      }
      // Префікс ролі Адміна
      if (user.is_admin) {
        const prefixSpan = document.createElement('span');
        prefixSpan.classList.add('role-prefix', 'admin-prefix');
        prefixSpan.textContent = 'А '; // Текст префіксу
        prefixSpan.title = 'Адміністратор';
        li.appendChild(prefixSpan);
      }
      // Префікс ролі Тренера
      if (user.is_trainer) {
        const prefixSpan = document.createElement('span');
        prefixSpan.classList.add('role-prefix', 'trainer-prefix');
        prefixSpan.textContent = 'Т '; // Текст префіксу
        prefixSpan.title = 'Тренер';
        li.appendChild(prefixSpan);
      }
      // Префікс статусу Самостійного
      if (user.is_independent) {
        const prefixSpan = document.createElement('span');
        prefixSpan.classList.add('role-prefix', 'independent-prefix'); // Новий клас для стилізації
        prefixSpan.textContent = 'С '; // 'С' - Самостійний
        prefixSpan.title = 'Самостійний користувач';
        li.appendChild(prefixSpan);
      }

      // Префікс для користувача "без тренера"
      if (user.registration_type === 'self') {
        const prefixSpan = document.createElement('span');
        prefixSpan.classList.add('role-prefix', 'self-prefix'); // Новий клас
        prefixSpan.textContent = '$ ';
        prefixSpan.title = 'Користувач "без тренера"';
        li.appendChild(prefixSpan);
      }
      // --- Кінець додавання префіксів ---

      // Створюємо span для імені
      const userNameSpan = document.createElement('span');
      userNameSpan.classList.add('user-name');
      userNameSpan.textContent = user.full_name || "Ім'я не вказано";

      // --- ▼▼▼ ОНОВЛЕНА ЛОГІКА ВИЗНАЧЕННЯ КОЛЬОРУ ▼▼▼ ---
      if (
        user.subscription_days_left !== null &&
        user.subscription_days_left <= 3
      ) {
        // Якщо залишилось 3 дні або менше - робимо помаранчевим
        userNameSpan.classList.add('subscription-expiring-soon-name');
      } else if (!user.has_active_subscription) {
        // Інакше, якщо підписка неактивна - робимо червоним
        userNameSpan.classList.add('subscription-inactive-name');
      }
      // Якщо підписка активна і до кінця більше 3 днів - жодних класів не додаємо

      // Створюємо span для телефону (як і раніше)
      const userPhoneSpan = document.createElement('span');
      userPhoneSpan.classList.add('user-phone');
      userPhoneSpan.textContent = ` (${user.phone})`;

      // Додаємо ім'я та телефон ПІСЛЯ префіксів
      li.appendChild(userNameSpan);
      li.appendChild(userPhoneSpan);

      li.dataset.phone = user.phone; // Зберігаємо телефон

      // Додаємо клас 'selected', якщо користувач обраний
      if (user.phone === selectedUserPhone) {
        li.classList.add('selected');
      }

      // Додаємо обробник кліку
      li.addEventListener('click', () => {
        selectedUserPhone = user.phone; // Оновлюємо обраного користувача
        console.log(
          `[User Click] Обрано: ${selectedUserPhone}. Поточна вкладка: ${currentAdminTab}`
        ); // ЛОГ ДІАГНОСТИКИ

        // Оновлюємо візуальне виділення у списку
        userListElement
          .querySelectorAll('li')
          .forEach((item) => item.classList.remove('selected'));
        li.classList.add('selected');

        // Завантажуємо контент для ПОТОЧНОЇ вкладки
        if (currentAdminTab === 'profiles') {
          loadProfileDetails(selectedUserPhone);
        } else if (currentAdminTab === 'progress') {
          loadProgressDetails(selectedUserPhone);
        } else if (currentAdminTab === 'workouts') {
          const listView = document.getElementById(adminWorkoutListViewId);
          const formView = document.getElementById(adminWorkoutFormViewId);
          const detailsView = document.getElementById(
            adminWorkoutDetailsViewId
          );
          if (listView) listView.style.display = 'block';
          if (formView) formView.style.display = 'none';
          if (detailsView) detailsView.style.display = 'none';
          loadAdminWorkoutList(selectedUserPhone);
        }
      });

      // Додаємо створений елемент до списку
      userListElement.appendChild(li);
    });

    console.log(
      '[displayUserList] Цикл створення елементів списку ЗАВЕРШЕНО успішно.'
    ); // Новий лог
  } catch (errorInLoop) {
    // Якщо помилка виникла всередині циклу forEach
    console.error(
      '[displayUserList] !!!!! Помилка всередині циклу forEach !!!!!:',
      errorInLoop
    );
    // Можна відобразити помилку прямо тут, щоб точно бачити її причину
    userListElement.innerHTML = `<li>Помилка при відображенні користувача: ${errorInLoop.message}</li>`;
  }

  // console.log("[displayUserList] Список відображено."); // Ваш старий лог в кінці
}

/**
 * Завантажує деталі профілю обраного користувача, генерує HTML та відображає його.
 * Також ініціює завантаження деталей підписки.
 * @param {string} phone - Номер телефону користувача.
 */
async function loadProfileDetails(phone) {
  const detailsDiv = document.getElementById('profile-details');
  if (!detailsDiv) {
    console.error('Елемент #profile-details не знайдено!');
    return;
  }

  detailsDiv.style.display = 'block';
  detailsDiv.innerHTML = '<p>Завантаження профілю...</p>';

  try {
    // userData тепер має структуру UserWithProfile
    const { data: userData } = await fetchWithAuth(`/admin/profiles/${phone}`);
    const profile = userData.profile; // Вся детальна інформація тепер у вкладеному об'єкті

    let profileHTML = `<h3>Профіль користувача: ${profile?.full_name || userData.phone}</h3>`;

    profileHTML += `<div class="user-roles-status">`;
    if (userData.is_admin) {
      profileHTML += `<span class="role admin" title="Адміністратор">Адміністратор</span>`;
    } else if (userData.is_trainer) {
      profileHTML += `<span class="role trainer" title="Тренер">Тренер</span>`;
    } else {
      const userTypeText =
        profile?.registration_type === 'self'
          ? "Користувач 'без тренера'"
          : "Користувач 'з тренером'";
      profileHTML += `<span class="role user" title="Звичайний користувач">${userTypeText}</span>`;
    }
    if (userData.is_independent) {
      profileHTML += `<span class="role independent" title="Може самостійно створювати тренування">Самостійний</span>`;
    }
    if (userData.has_active_subscription) {
      profileHTML += `<span class="status subscription-active" title="Є активна підписка">Підписка активна</span>`;
    } else {
      profileHTML += `<span class="status subscription-inactive" title="Підписка неактивна або відсутня">Підписка не активна</span>`;
    }

    if (profile?.auto_renew_enabled) {
      profileHTML += `<span class="status auto-renew-on" title="Автоподовження підписки увімкнено">Автоподовження 🔁</span>`;
    } else {
      profileHTML += `<span class="status auto-renew-off" title="Автоподовження підписки вимкнено">Автоподовження 🚫</span>`;
    }

    if (userData.is_suspended) {
      const suspensionDateStr = userData.suspension_date
        ? new Date(userData.suspension_date).toLocaleDateString('uk-UA', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
          })
        : 'невідомої дати';
      profileHTML += `<span class="status suspended" title="Обліковий запис призупинено">Призупинено (з ${suspensionDateStr})</span>`;
    } else {
      profileHTML += `<span class="status active" title="Обліковий запис активний">Активний</span>`;
    }
    profileHTML += `</div>`;

    // Бекенд більше не повертає 'who_registered', тому цей блок видалено.
    // Інформація про тип реєстрації вже є вище.

    if (profile) {
      const telegramUsername = profile.telegram_link
        ? profile.telegram_link.replace(/^@/, '')
        : null;
      const instagramUsername = profile.instagram_link
        ? profile.instagram_link.replace(/^@/, '')
        : null;

      profileHTML += `
                <p><strong>Повне ім'я:</strong> <span class="profile-data">${profile.full_name || '-'}</span></p>
                <p><strong>Публічне ім'я:</strong> <span class="profile-data">${profile.display_name || '-'}</span></p>
                <p><strong>Email:</strong> <span class="profile-data">${profile.email ? `<a href="mailto:${profile.email}">${profile.email}</a>` : '-'}</span></p>
                <p><strong>Telegram:</strong> <span class="profile-data">${telegramUsername ? `<a href="https://t.me/${telegramUsername}" target="_blank">${profile.telegram_link}</a>` : '-'}</span></p>
                <p><strong>Instagram:</strong> <span class="profile-data">${instagramUsername ? `<a href="https://www.instagram.com/${instagramUsername}" target="_blank">${profile.instagram_link}</a>` : '-'}</span></p>
                <p><strong>Стать:</strong> <span class="profile-data">${translateField('gender', profile.gender)}</span></p>
                <p><strong>Вік:</strong> <span class="profile-data">${profile.age || '-'}</span></p>
                <p><strong>Вага:</strong> <span class="profile-data">${profile.weight || '-'} кг</span></p>
                <p><strong>Зріст:</strong> <span class="profile-data">${profile.height || '-'} см</span></p>
                <p><strong>Ціль:</strong> <span class="profile-data">${translateField('goal', profile.goal)}</span></p>
                <p><strong>Активність:</strong> <span class="profile-data">${translateField('daytime_activity', profile.daytime_activity)}</span></p>
                <p><strong>Тип тренувань:</strong> <span class="profile-data">${translateField('type_of_training', profile.type_of_training)}</span></p>
                <p><strong>Рівень підготовки:</strong> <span class="profile-data">${translateField('level_of_training', profile.level_of_training)}</span></p>
                <p><strong>Тренувань на тиждень:</strong> <span class="profile-data">${profile.training_days_per_week || 'не вказано'}</span></p>
                <p><strong>Бажані дні тренувань:</strong> <span class="profile-data">${Array.isArray(profile.preferred_training_weekdays) && profile.preferred_training_weekdays.length > 0 ? profile.preferred_training_weekdays.join(', ') : 'не вказано'}</span></p>
                <p><strong>Проблеми зі здоров'ям:</strong> <span class="profile-data">${translateField('health_problems', profile.health_problems)}</span></p>
                <p><strong>Інші проблеми зі здоров'ям:</strong> <span class="profile-data">${profile.other_health_problems || '-'}</span></p>
                <p><strong>Виключені вправи:</strong> <span class="profile-data">${(Array.isArray(profile.excluded_exercises) ? profile.excluded_exercises.join(', ') : profile.excluded_exercises) || '-'}</span></p>
                <p><strong>Виключені продукти:</strong> <span class="profile-data">${translateField('excluded_products', profile.excluded_products)}</span></p>
                <p><strong>Інші виключені продукти:</strong> <span class="profile-data">${profile.other_excluded_products || '-'}</span></p>
                <p><strong>К-ть прийомів їжі:</strong> <span class="profile-data">${translateField('number_of_meals', profile.number_of_meals)}</span></p>
                <p><strong>Дата реєстрації:</strong> <span class="profile-data">${profile.registration_date ? new Date(profile.registration_date).toLocaleDateString('uk-UA') : '-'}</span></p>
            `;
    } else {
      profileHTML += `<p style="margin-top: 15px;"><i>Профіль користувача ще не заповнено.</i></p>`;
    }

    profileHTML += `<div class="admin-actions">`;

    // Використовуємо registration_type з об'єкта profile
    const registrationType = profile?.registration_type;

    if (registrationType === 'by_trainer') {
      profileHTML += `<button id="change-user-type-btn" class="admin-action-btn" data-current-type="by_trainer">Зробити "без тренера"</button>`;
    } else if (registrationType === 'self') {
      profileHTML += `<button id="change-user-type-btn" class="admin-action-btn" data-current-type="self">Зробити "з тренером"</button>`;
    }

    const currentAdminPhone = localStorage
      .getItem('admin_phone')
      ?.replace('+', '');
    if (phone !== currentAdminPhone) {
      profileHTML += `<button id="change-password-btn" class="admin-action-btn" title="Сгенерувати новий випадковий пароль для цього користувача">Змінити пароль</button>`;
    }
    if (userData.is_independent) {
      profileHTML += `<button id="toggle-independent-btn" class="admin-action-btn suspend" title="Заборонити користувачу самостійно створювати тренування">Зробити звичайним</button>`;
    } else {
      profileHTML += `<button id="toggle-independent-btn" class="admin-action-btn activate" title="Дозволити користувачу самостійно створювати тренування">Зробити самостійним</button>`;
    }
    if (!userData.is_admin) {
      if (userData.is_suspended) {
        profileHTML += `<button id="unsuspend-user-btn" class="admin-action-btn activate" title="Відновити доступ користувача до особистого кабінету">Відновити аккаунт</button>`;
      } else {
        profileHTML += `<button id="suspend-user-btn" class="admin-action-btn suspend" title="Заблокувати доступ користувача та видалити його тренування">Призупинити аккаунт</button>`;
      }
      profileHTML += `<button id="delete-user-btn" class="admin-action-btn delete" title="ПОВНІСТЮ видалити користувача та всі його дані! Незворотня дія!">Видалити користувача</button>`;
    }
    profileHTML += `</div>`;
    profileHTML += `<div id="admin-action-message" style="margin-top: 10px; font-weight: bold;"></div>`;
    profileHTML += `<div id="subscription-management-section"></div>`;

    detailsDiv.innerHTML = profileHTML;

    // Прив'язуємо обробники до щойно створених кнопок
    const changeTypeBtn = detailsDiv.querySelector('#change-user-type-btn');
    if (changeTypeBtn) {
      changeTypeBtn.addEventListener('click', () => {
        const currentType = changeTypeBtn.dataset.currentType;
        handleChangeUserTypeClick(phone, currentType);
      });
    }

    const changePassBtn = detailsDiv.querySelector('#change-password-btn');
    if (changePassBtn)
      changePassBtn.addEventListener('click', () => changePassword(phone));

    const toggleIndependentBtn = detailsDiv.querySelector(
      '#toggle-independent-btn'
    );
    if (toggleIndependentBtn) {
      toggleIndependentBtn.addEventListener('click', () =>
        toggleIndependentStatus(phone, userData.is_independent)
      );
    }

    const suspendBtn = detailsDiv.querySelector('#suspend-user-btn');
    if (suspendBtn)
      suspendBtn.addEventListener('click', () => suspendUser(phone));

    const unsuspendBtn = detailsDiv.querySelector('#unsuspend-user-btn');
    if (unsuspendBtn)
      unsuspendBtn.addEventListener('click', () => unsuspendUser(phone));

    const deleteBtn = detailsDiv.querySelector('#delete-user-btn');
    if (deleteBtn) deleteBtn.addEventListener('click', () => deleteUser(phone));

    loadSubscriptionDetails(phone);
  } catch (error) {
    console.error(`Помилка завантаження профілю для ${phone}:`, error);
    detailsDiv.innerHTML = `<p style="color: red;">Помилка завантаження профілю: ${error.message}</p>`;
  }
}

// Нова функція для обробки зміни типу користувача ("з тренером" або "без тренера")
async function handleChangeUserTypeClick(phone, currentType) {
  const messageDivId = 'admin-action-message';

  // Сценарій 1: Робимо користувача "БЕЗ тренера"
  if (currentType === 'by_trainer') {
    if (
      !confirm(
        `Ви впевнені, що хочете змінити тип цього користувача на "без тренера"? Його поле "Зареєстрував" буде очищено.`
      )
    )
      return;

    displayStatus(messageDivId, 'Зміна типу...');
    try {
      await fetchWithAuth(
        `/admin/users/${phone}/change-type`,
        {
          method: 'POST',
          body: JSON.stringify({ registration_type: 'self' }),
        },
        messageDivId
      );
      displayStatus(
        messageDivId,
        'Тип користувача успішно змінено.',
        false,
        4000
      );
      usersCache = null; // Оновлюємо кеш
      loadProfileDetails(phone); // Перезавантажуємо профіль
    } catch (error) {
      console.error('Помилка зміни типу:', error);
    }
    return;
  }

  // Сценарій 2: Робимо користувача "З тренером"
  if (currentType === 'self') {
    displayStatus(messageDivId, 'Завантаження списку тренерів...');
    try {
      // Отримуємо список тренерів з нового ендпоінту
      const { data: trainers } = await fetchWithAuth('/admin/users/trainers');
      if (!trainers || trainers.length === 0) {
        alert("Помилка: Не знайдено жодного користувача з роллю 'Тренер'.");
        displayStatus(messageDivId, '', false);
        return;
      }

      // Створюємо HTML для випадаючого списку тренерів
      let optionsHTML = trainers
        .map(
          (t) =>
            `<option value="${t.phone}">${t.full_name} (${t.phone})</option>`
        )
        .join('');

      // Використовуємо кастомне модальне вікно, щоб запитати, якого тренера призначити
      showCustomConfirmationDialogWithOptions(
        `Оберіть нового тренера для користувача ${phone}:`,
        optionsHTML,
        async (selectedValue) => {
          // Функція, що виконається при підтвердженні
          if (!selectedValue) {
            alert('Будь ласка, оберіть тренера.');
            return;
          }
          displayStatus(messageDivId, 'Призначення тренера...');
          await fetchWithAuth(
            `/admin/users/${phone}/change-type`,
            {
              method: 'POST',
              body: JSON.stringify({
                registration_type: 'by_trainer',
                new_trainer_phone: selectedValue,
              }),
            },
            messageDivId
          );
          displayStatus(
            messageDivId,
            'Тип користувача та тренер успішно змінені.',
            false,
            4000
          );
          usersCache = null; // Оновлюємо кеш
          loadProfileDetails(phone); // Перезавантажуємо профіль
        }
      );
      displayStatus(messageDivId, '', false); // Ховаємо "Завантаження..."
    } catch (error) {
      displayStatus(messageDivId, `Помилка: ${error.message}`, true);
    }
  }
}

/**
 * Запитує та обробляє зміну пароля користувача.
 * @param {string} phone - Номер телефону користувача.
 */
async function changePassword(phone) {
  const messageDivId = 'admin-action-message'; // Використовуємо спільний div для повідомлень
  if (
    !confirm(`Ви впевнені, що хочете змінити пароль для користувача ${phone}?`)
  ) {
    displayStatus(messageDivId, ''); // Очищаємо, якщо скасовано
    return;
  }
  displayStatus(messageDivId, 'Зміна пароля...');

  try {
    // Використовуємо fetchWithAuth
    const { data } = await fetchWithAuth(
      `/admin/users/${phone}/reset-password`,
      {
        method: 'POST',
      },
      messageDivId
    ); // Передаємо ID для статусу
    displayStatus(
      messageDivId,
      `Пароль змінено! Новий пароль: ${data.generated_password}`,
      false
    );
  } catch (error) {
    // fetchWithAuth вже відобразив помилку
    console.error('Помилка зміни пароля:', error);
  }
}

/**
 * Змінює статус "самостійний" для користувача.
 * @param {string} phone - Телефон користувача.
 * @param {boolean} isCurrentlyIndependent - Поточний статус користувача.
 */
async function toggleIndependentStatus(phone, isCurrentlyIndependent) {
  const newStatus = !isCurrentlyIndependent;
  const actionText = newStatus ? 'НАДАТИ' : 'ЗАБРАТИ';
  const userTypeText = newStatus ? 'самостійного' : 'звичайного';

  if (
    !confirm(
      `Ви впевнені, що хочете ${actionText} користувачу ${phone} статус "${userTypeText}"?`
    )
  )
    return;

  const messageDivId = 'admin-action-message';
  displayStatus(messageDivId, 'Зміна статусу...');

  try {
    const { data: response } = await fetchWithAuth(
      `/admin/users/${phone}/set-independent`,
      {
        method: 'POST',
        body: JSON.stringify({ independent: newStatus }),
      },
      messageDivId
    );

    displayStatus(
      messageDivId,
      response.message || `Статус для ${phone} оновлено.`,
      false,
      5000
    );

    // Оновлюємо дані, щоб побачити зміни
    usersCache = null; // Скидаємо кеш, щоб список оновився
    loadProfileDetails(phone); // Перезавантажуємо деталі профілю
    if (currentAdminTab === 'profiles') {
      loadUserList(); // Оновлюємо список, якщо ми на вкладці профілів
    }
  } catch (error) {
    // fetchWithAuth вже відобразить помилку
    console.error("Помилка зміни статусу 'самостійний':", error);
  }
}

/**
 * Призупиняє аккаунт користувача.
 * @param {string} phone - Телефон користувача.
 */
async function suspendUser(phone) {
  const messageDivId = 'admin-action-message';
  if (
    !confirm(
      `Ви впевнені, що хочете ПРИЗУПИНИТИ дію облікового запису користувача ${phone}? Він не зможе увійти в особистий кабінет до моменту відновлення.`
    )
  )
    return;
  displayStatus(messageDivId, 'Призупинення аккаунту...');
  try {
    const { data: response } = await fetchWithAuth(
      `/admin/users/${phone}/suspend`,
      { method: 'POST' },
      messageDivId
    );
    displayStatus(
      messageDivId,
      response.message || `Аккаунт ${phone} призупинено.`,
      false,
      5000
    );
    usersCache = null;
    loadProfileDetails(phone); // Оновити вигляд профілю
    // Можна також оновити вигляд у списку, якщо він видимий
    if (currentAdminTab === 'profiles') {
      const userListItem = document.querySelector(
        `#user-list li[data-phone="${phone}"]`
      );
      if (userListItem) userListItem.classList.add('suspended-user'); // Додати клас
    }
  } catch (error) {
    console.error('Помилка призупинення:', error);
  }
}

/**
 * Відновлює аккаунт користувача.
 * @param {string} phone - Телефон користувача.
 */
async function unsuspendUser(phone) {
  const messageDivId = 'admin-action-message';
  if (
    !confirm(
      `Ви впевнені, що хочете ВІДНОВИТИ дію облікового запису користувача ${phone}?`
    )
  )
    return;

  displayStatus(messageDivId, 'Відновлення аккаунту...');
  try {
    const { data: response } = await fetchWithAuth(
      `/admin/users/${phone}/unsuspend`,
      { method: 'POST' },
      messageDivId
    );
    displayStatus(
      messageDivId,
      response.message || `Аккаунт ${phone} відновлено.`,
      false,
      5000
    );
    usersCache = null; // Оновити кеш
    loadProfileDetails(phone); // Оновити вигляд профілю
    // Можна також оновити вигляд у списку, якщо він видимий
    if (currentAdminTab === 'profiles') {
      const userListItem = document.querySelector(
        `#user-list li[data-phone="${phone}"]`
      );
      if (userListItem) userListItem.classList.remove('suspended-user'); // Прибрати клас
    }
  } catch (error) {
    console.error('Помилка відновлення:', error);
  }
}

/**
 * Видаляє користувача.
 * @param {string} phone - Телефон користувача.
 */
async function deleteUser(phone) {
  const messageDivId = 'admin-action-message';
  if (
    !confirm(
      `!!! УВАГА !!!\nВи ТОЧНО впевнені, що хочете ПОВНІСТЮ ВИДАЛИТИ користувача ${phone} та всі його дані (профіль, прогрес, тренування, налаштування)?\nЦЯ ДІЯ НЕЗВОРОТНЯ!`
    )
  )
    return;

  displayStatus(messageDivId, 'Видалення користувача...');
  try {
    const { data: response } = await fetchWithAuth(
      `/admin/users/${phone}/delete`,
      { method: 'DELETE' },
      messageDivId
    );
    displayStatus(
      messageDivId,
      response.message || `Користувач ${phone} видалений.`,
      false,
      5000
    );
    usersCache = null; // Оновити кеш
    selectedUserPhone = null; // Скинути обраного користувача
    document.getElementById('profile-details').style.display = 'none'; // Сховати блок деталей
    loadUserList(); // Оновити список користувачів
    // Можна переключити на вкладку Профілі, якщо були на іншій
    openTab(null, 'profiles');
  } catch (error) {
    console.error('Помилка видалення:', error);
  }
}

/**
 * Завантажує дані прогресу обраного користувача.
 * @param {string} phone - Номер телефону користувача.
 */
async function loadProgressDetails(phone) {
  const detailsDiv = document.getElementById('progress-details');
  const tableBody = detailsDiv?.querySelector('#progress-table-admin tbody');
  const header = detailsDiv?.querySelector('h3');

  if (!detailsDiv || !tableBody || !header) {
    console.error('Елементи для відображення прогресу не знайдено.');
    return;
  }
  detailsDiv.style.display = 'block'; // Показуємо блок
  header.textContent = 'Завантаження прогресу...';
  tableBody.innerHTML = '<tr><td colspan="6">Завантаження...</td></tr>';

  try {
    const { data: progressList } = await fetchWithAuth(
      `/admin/progress/${phone}`
    );

    const selectedUser = usersCache?.find((user) => user.phone === phone);
    const userName = selectedUser ? selectedUser.full_name || phone : phone;
    header.textContent = `Прогрес користувача: ${userName}`;

    if (progressList.length === 0) {
      tableBody.innerHTML =
        '<tr><td colspan="6">Записи прогресу відсутні.</td></tr>';
    } else {
      tableBody.innerHTML = ''; // Очищуємо перед заповненням
      // Сортуємо від новіших до старіших
      progressList.sort((a, b) => new Date(b.date) - new Date(a.date));
      progressList.forEach((item) => {
        const row = tableBody.insertRow(); // Створюємо рядок
        row.innerHTML = `
                    <td>${new Date(item.date).toLocaleDateString('uk-UA')}</td>
                    <td>${item.weight ?? '-'}</td>
                    <td>${item.chest ?? '-'}</td>
                    <td>${item.waist ?? '-'}</td>
                    <td>${item.abdomen ?? '-'}</td>
                    <td>${item.hips ?? '-'}</td>
                `;
      });
    }
  } catch (error) {
    header.textContent = 'Прогрес користувача';
    tableBody.innerHTML = `<tr><td colspan="6">Помилка завантаження прогресу: ${error.message}</td></tr>`;
  }
}

// ========== ЛОГІКА КЕРУВАННЯ ПІДПИСКАМИ ==========

/**
 * ФІНАЛЬНА ВЕРСІЯ: Функція відповідає ТІЛЬКИ за завантаження та відображення даних.
 * Уся логіка обробників подій тепер знаходиться в attachAdminPanelListeners.
 */
async function loadSubscriptionDetails(phone) {
  const container = document.getElementById('subscription-management-section');
  if (!container) {
    console.error('Елемент #subscription-management-section не знайдено!');
    return;
  }

  container.innerHTML = '<p>Завантаження даних про підписки...</p>';

  try {
    // Завантажуємо дані та викликаємо функцію, яка малює HTML
    const { data: subscriptions } = await fetchWithAuth(
      `/admin/subscriptions/${phone}`
    );

    // Передаємо телефон у функцію відображення, він може знадобитися
    displaySubscriptionDetails(subscriptions, phone);
  } catch (error) {
    container.innerHTML = `<p style="color: red;">Помилка завантаження підписок: ${error.message}</p>`;
  }
}

/**
 * ОНОВЛЕНО: Відображає поле "План" та помічає підписки зі знижкою.
 * @param {Array} subscriptions - Масив об'єктів підписок.
 * @param {string} phone - Телефон користувача.
 */
function displaySubscriptionDetails(subscriptions, phone) {
  const container = document.getElementById('subscription-management-section');
  if (!container) return;

  // Визначаємо, чи є у користувача хоча б одна успішна підписка "без тренера"
  const hasPaidWithoutTrainer = subscriptions.some(
    (s) => s.plan_type === 'without_trainer' && s.status === 'active'
  );

  let historyHTML = '<h4>Історія підписок</h4>';
  historyHTML +=
    '<div id="subscription-list-status" class="status-message" style="min-height: 1em; margin-bottom: 10px;"></div>';

  if (subscriptions && subscriptions.length > 0) {
    subscriptions.sort(
      (a, b) => new Date(b.start_date) - new Date(a.start_date)
    );

    historyHTML += '<ul class="subscription-list">';
    subscriptions.forEach((sub) => {
      const startDate = new Date(sub.start_date).toLocaleDateString('uk-UA');
      const endDate = new Date(sub.end_date).toLocaleDateString('uk-UA');
      const statusTranslations = {
        active: 'Активна',
        expired: 'Закінчилась',
        cancelled: 'Скасована',
        pending_payment: 'Очікує оплати',
      };

      // Визначаємо текст для плану
      const planText =
        sub.plan_type === 'without_trainer' ? 'Без тренера' : 'З тренером';

      // Визначаємо, чи це була підписка зі знижкою
      let discountNote = '';
      // Логіка: якщо це підписка "без тренера" І в історії НЕ було інших активних підписок "без тренера"
      // до моменту старту ЦІЄЇ підписки, то вона була першою (зі знижкою).
      // (Це спрощена логіка, але для відображення її достатньо)
      const otherPaidSubscriptionsBeforeThis = subscriptions.some(
        (otherSub) =>
          otherSub.id !== sub.id &&
          otherSub.plan_type === 'without_trainer' &&
          otherSub.status === 'active' &&
          new Date(otherSub.start_date) < new Date(sub.start_date)
      );

      if (
        sub.plan_type === 'without_trainer' &&
        !otherPaidSubscriptionsBeforeThis
      ) {
        discountNote = ' <span class="discount-badge">(Знижка)</span>';
      }

      historyHTML += `
                <li class="subscription-item status-${sub.status}">
                    <div class="subscription-info">
                        <strong>Тип:</strong> ${translateField('subscription_type', sub.subscription_type)}<br>
                        <strong>План:</strong> ${planText}${discountNote}<br>
                        <strong>Період:</strong> ${startDate} - ${endDate}<br>
                        <strong>Статус:</strong> ${statusTranslations[sub.status] || sub.status}
                    </div>
                    <div class="subscription-actions">
                        ${
                          sub.status === 'active'
                            ? `<button class="admin-action-btn suspend" data-sub-id="${sub.id}" data-new-status="cancelled">Скасувати</button>`
                            : `<button class="admin-action-btn activate" data-sub-id="${sub.id}" data-new-status="active">Активувати</button>`
                        }
                    </div>
                </li>
            `;
    });
    historyHTML += '</ul>';
  } else {
    historyHTML += '<p>Підписок ще не було.</p>';
  }

  const formHTML = `
        <h4>Додати нову підписку</h4>
        <form id="add-subscription-form" class="subscription-form">
            <div class="form-group">
                <label for="subscription-plan-type">План:</label>
                <select id="subscription-plan-type" name="plan_type" required>
                    <option value="with_trainer">З тренером</option>
                    <option value="without_trainer">Без тренера</option>
                </select>
            </div>
            <div class="form-group">
                <label for="subscription-type">Тип підписки:</label>
                <select id="subscription-type" name="subscription_type" required>
                    <option value="weekly">Тиждень</option>
                    <option value="monthly">Місяць</option>
                    <option value="quarterly">3 місяці</option>
                    <option value="semi_annual">Півроку</option>
                    <option value="annual">Рік</option>
                </select>
            </div>
            <div class="form-group">
                <label for="subscription-end-date">Дата закінчення:</label>
                <input type="date" id="subscription-end-date" name="end_date" required>
            </div>
            <button type="submit" class="admin-action-btn">Створити підписку</button>
            <div id="add-subscription-message" style="margin-top: 10px;"></div>
        </form>
    `;

  // Просто встановлюємо HTML, не додаючи нових обробників
  container.innerHTML = historyHTML + formHTML;
}

/**
 * Обробляє створення нової підписки і оновлює список
 * через повне перезавантаження для надійності.
 */
async function handleAddSubscription(event, phone) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('button[type="submit"]');
  const messageDivId = 'add-subscription-message';

  displayStatus(messageDivId, 'Створення підписки...');
  button.disabled = true;

  const subscriptionData = {
    subscription_type: form.elements['subscription_type'].value,
    plan_type: form.elements['plan_type'].value,
    end_date: form.elements['end_date'].value,
    status: 'active',
  };

  if (!subscriptionData.end_date) {
    displayStatus(messageDivId, 'Будь ласка, оберіть дату закінчення.', true);
    button.disabled = false;
    return;
  }

  try {
    await fetchWithAuth(
      `/admin/subscriptions/${phone}`,
      {
        method: 'POST',
        body: JSON.stringify(subscriptionData),
      },
      messageDivId
    );

    displayStatus(messageDivId, 'Підписку успішно створено!', false, 3000);
    form.reset();

    // Повністю перезавантажуємо блок, щоб отримати свіжі дані
    loadSubscriptionDetails(phone);
  } catch (error) {
    console.error('Помилка створення підписки:', error);
  } finally {
    button.disabled = false;
  }
}

/**
 * Обробляє зміну статусу існуючої підписки.
 * @param {HTMLButtonElement} button - Елемент кнопки, на яку натиснули.
 * @param {string} phone - Телефон користувача.
 */
async function handleUpdateSubscriptionStatus(button, phone) {
  const subId = button.dataset.subId;
  const newStatus = button.dataset.newStatus;
  const actionText = newStatus === 'active' ? 'АКТИВУВАТИ' : 'СКАСУВАТИ';

  if (!confirm(`Ви впевнені, що хочете ${actionText} цю підписку?`)) return;

  const messageDivId = 'subscription-list-status';
  displayStatus(messageDivId, 'Оновлення статусу...');

  try {
    // --- ВИПРАВЛЕНО: URL тепер включає і телефон, і ID підписки ---
    await fetchWithAuth(
      `/admin/subscriptions/${phone}/${subId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      },
      messageDivId
    );

    displayStatus(
      messageDivId,
      'Статус підписки успішно оновлено!',
      false,
      4000
    );
    // Оновлюємо список, щоб побачити зміни
    loadSubscriptionDetails(phone);
  } catch (error) {
    console.error(`Помилка оновлення статусу підписки ${subId}:`, error);
  }
}

// ========== ЛОГІКА ВКЛАДКИ "ТРЕНУВАННЯ" ==========

/**
 * Завантажує список тренувань для обраного користувача (АДМІНКА) з пагінацією.
 * @param {string} phone - Телефон користувача.
 * @param {boolean} isLoadMore - Прапорець, що вказує, чи це дозавантаження чи перший запит.
 */
async function loadAdminWorkoutList(phone, isLoadMore = false) {
  const listContainer = document.getElementById(adminWorkoutListId);
  const statusDiv = document.getElementById(adminWorkoutListStatusId);
  const userNameSpan = document.getElementById('admin-workout-list-username');
  const addBtn = document.getElementById('show-add-training-form-btn');
  const loadMoreContainer = document.getElementById(
    'admin-workout-load-more-container'
  ); // NEW

  if (
    !listContainer ||
    !statusDiv ||
    !userNameSpan ||
    !addBtn ||
    !loadMoreContainer
  ) {
    console.error('loadAdminWorkoutList: Не знайдено необхідні елементи DOM.');
    return;
  }

  if (isLoadingMoreWorkouts) return; // Захист від подвійних кліків
  isLoadingMoreWorkouts = true;

  if (!isLoadMore) {
    // Якщо це перший запит для цього користувача
    listContainer.innerHTML = ''; // Очищуємо список
    currentWorkoutPage = 0;
    totalWorkoutsAvailable = 0;
    const selectedUser = usersCache?.find((user) => user.phone === phone);
    userNameSpan.textContent = selectedUser
      ? selectedUser.full_name || phone
      : phone;
    addBtn.style.display = 'inline-block';
  }

  displayStatus(adminWorkoutListStatusId, 'Завантаження тренувань...');
  loadMoreContainer.innerHTML = ''; // Очищуємо контейнер кнопки

  const skip = currentWorkoutPage * WORKOUTS_PER_PAGE;

  try {
    const { data: plans, headers } = await fetchWithAuth(
      `/admin/trainings/${phone}/training-plans?skip=${skip}&limit=${WORKOUTS_PER_PAGE}`, // <-- ВИПРАВЛЕНО: Правильний шлях
      {},
      adminWorkoutListStatusId
    );

    if (!isLoadMore && (!plans || plans.length === 0)) {
      listContainer.innerHTML = '<p>Тренування поки відсутні.</p>';
      isLoadingMoreWorkouts = false;
      return;
    }

    if (headers.has('x-total-count')) {
      totalWorkoutsAvailable = parseInt(headers.get('x-total-count'), 10);
    }

    plans.sort((a, b) => new Date(b.date) - new Date(a.date));

    plans.forEach((plan) => {
      const listItem = document.createElement('div');
      listItem.classList.add('admin-workout-list-item');
      listItem.classList.toggle('completed', plan.completed);
      listItem.setAttribute('data-plan-id', plan.id);

      // НОВЕ: Перевіряємо прапорець з бекенду
      if (plan.contains_excluded_exercise === true) {
        listItem.classList.add('admin-plan-contains-excluded');
        console.log(
          `План ID ${plan.id} ("${plan.title}") позначено як такий, що містить виключені вправи (з бекенду).`
        );
      }

      const planDateObj = new Date(plan.date);
      // ... (решта коду для форматування дати, створення contentContainer, indicatorsContainer, actionsContainer)
      const isValidDate = !isNaN(planDateObj.getTime());
      const planDateFormatted = isValidDate
        ? planDateObj.toLocaleDateString('uk-UA', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })
        : 'Невірна дата';
      const planWeekday = isValidDate
        ? planDateObj.toLocaleDateString('uk-UA', { weekday: 'short' })
        : '';

      const contentContainer = document.createElement('div');
      contentContainer.classList.add('workout-list-content');
      contentContainer.style.cursor = 'pointer';
      contentContainer.title = 'Натисніть, щоб переглянути деталі тренування';
      contentContainer.innerHTML = `
                <strong class="workout-list-date">${planDateFormatted} (${planWeekday})</strong>
                <span class="workout-list-title">${plan.title || 'Без назви'}</span>
                ${plan.description ? `<p class="workout-list-desc">${plan.description.substring(0, 100)}${plan.description.length > 100 ? '...' : ''}</p>` : ''}
            `;
      contentContainer.addEventListener('click', () => {
        showAdminWorkoutDetails(plan.id, phone); // phone тут - це userPhone
      });

      const indicatorsContainer = document.createElement('div');
      indicatorsContainer.classList.add('list-item-indicators-top-right');
      let hasIndicators = false;
      if (plan.completed) {
        const completionIndicator = document.createElement('span');
        completionIndicator.classList.add('completion-indicator');
        completionIndicator.title = 'Виконано';
        completionIndicator.textContent = '✔';
        indicatorsContainer.appendChild(completionIndicator);
        hasIndicators = true;
      }
      if (plan.feedback) {
        const feedbackIndicator = document.createElement('span');
        feedbackIndicator.classList.add('feedback-indicator');
        feedbackIndicator.title = 'Є відгук';
        feedbackIndicator.textContent = '💬';
        indicatorsContainer.appendChild(feedbackIndicator);
        hasIndicators = true;
      }

      const actionsContainer = document.createElement('div');
      actionsContainer.classList.add('workout-list-actions');

      const editButton = document.createElement('button');
      editButton.innerHTML = '✏️';
      editButton.classList.add('edit-plan-btn');
      editButton.title = `Редагувати тренування "${plan.title || 'Без назви'}"`;
      editButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const confirmMessage = `Ви дійсно хочете відредагувати тренування "${plan.title || 'Без назви'}"?`;
        if (typeof showCustomConfirmationDialog === 'function') {
          showCustomConfirmationDialog(confirmMessage, () => {
            loadWorkoutForEditing(plan.id, phone);
          });
        } else {
          if (confirm(confirmMessage)) {
            loadWorkoutForEditing(plan.id, phone);
          }
        }
      });
      actionsContainer.appendChild(editButton);

      const copyButton = document.createElement('button');
      copyButton.innerHTML = '📄'; // Або іконка копіювання, або текст "Копіювати"
      copyButton.classList.add('copy-plan-btn'); // Додайте клас для стилізації
      copyButton.title = `Копіювати тренування "${plan.title || 'Без назви'}" для іншого користувача`;
      copyButton.addEventListener('click', (event) => {
        event.stopPropagation(); // Зупинити спливання події, щоб не спрацював клік на весь елемент списку
        handleInitiateCopyWorkout(plan.id, phone); // 'phone' тут - це телефон поточного (джерельного) користувача
      });
      actionsContainer.appendChild(copyButton); // Додаємо кнопку до контейнера дій

      listItem.innerHTML = '';
      listItem.appendChild(contentContainer);
      if (hasIndicators) {
        listItem.appendChild(indicatorsContainer);
      }
      listItem.appendChild(actionsContainer);
      listContainer.appendChild(listItem);
    });

    currentWorkoutPage++;

    // Логіка для кнопки "Показати ще"
    const loadedCount = listContainer.children.length;
    if (loadedCount < totalWorkoutsAvailable) {
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.textContent = 'Показати ще 10 тренувань';
      loadMoreBtn.className = 'load-more-btn'; // Клас для стилізації
      loadMoreBtn.onclick = () => loadAdminWorkoutList(phone, true);
      loadMoreContainer.appendChild(loadMoreBtn);
    } else {
      if (totalWorkoutsAvailable > 0) {
        loadMoreContainer.innerHTML = `<p>Всі ${totalWorkoutsAvailable} тренувань завантажено.</p>`;
      }
    }
  } catch (error) {
    displayStatus(
      adminWorkoutListStatusId,
      `Помилка: ${error.message || 'Невідома помилка'}`,
      true
    );
  } finally {
    isLoadingMoreWorkouts = false;
    // Очищуємо статус, якщо він був "Завантаження..."
    if (statusDiv.innerText === 'Завантаження тренувань...') {
      displayStatus(adminWorkoutListStatusId, '');
    }
  }
}

/**
 * Відображає форму для створення/редагування тренування.
 * Додано параметр planData для заповнення форми при редагуванні.
 * ОНОВЛЕНО: Завантажує чернетку при відкритті.
 */
async function showAddTrainingForm(planDataToEdit = null) {
  // <--- Параметр тепер називається planDataToEdit
  const listView = document.getElementById(adminWorkoutListViewId);
  const formView = document.getElementById(adminWorkoutFormViewId);
  const detailsView = document.getElementById(adminWorkoutDetailsViewId);
  const formTitle = document.getElementById('admin-workout-form-title');
  const clearDraftBtn = document.getElementById('clear-workout-draft-btn');

  let effectivePlanData = planDataToEdit; // Використовуємо planDataToEdit
  let userPhoneForSetup;
  let currentFormModeTitle = '';
  let loadDraftAfterSetup = true;
  let proceedWithSetup = true; // Додано для контролю виходу з функції

  // Сценарій 1: Активний режим копіювання
  // Перевіряємо, чи НЕМАЄ даних для прямого редагування (!planDataToEdit)
  // І чи активний режим копіювання
  if (
    !planDataToEdit &&
    isCopyModeActive &&
    workoutToCopyData &&
    selectedUserPhone
  ) {
    const sourceWorkoutTitle = workoutToCopyData.title || 'Без назви';
    const targetUserObject = usersCache?.find(
      (u) => u.phone === selectedUserPhone
    );
    const targetUserName = targetUserObject
      ? targetUserObject.full_name || selectedUserPhone
      : selectedUserPhone;

    const userConfirmation = confirm(
      `Знайдено дані для копіювання тренування "${sourceWorkoutTitle}".\n\n` +
        `Використати ці дані для створення нового тренування для користувача ${targetUserName}?`
    );

    if (userConfirmation) {
      console.log(
        `[showAddTrainingForm] Користувач ПІДТВЕРДИВ копіювання для: ${targetUserName}.`
      );
      effectivePlanData = { ...workoutToCopyData };
      userPhoneForSetup = selectedUserPhone;
      currentEditingPlanId = null;
      currentFormModeTitle = `Копіювання тренування для: ${targetUserName}`;
      loadDraftAfterSetup = false;
    } else {
      console.log(
        `[showAddTrainingForm] Користувач СКАСУВАВ копіювання. Скидання даних.`
      );
      workoutToCopyData = null;
      isCopyModeActive = false;
      effectivePlanData = null; // Перехід до створення нового порожнього плану
      userPhoneForSetup = selectedUserPhone;
      currentEditingPlanId = null;
      currentFormModeTitle = `Створення нового тренування для: ${targetUserName}`;
      if (!selectedUserPhone) {
        // Додаткова перевірка
        alert(
          'Будь ласка, оберіть користувача для створення нового тренування.'
        );
        proceedWithSetup = false;
      }
    }
  } else if (planDataToEdit) {
    // Сценарій 2: Пряме РЕДАГУВАННЯ (planDataToEdit тепер використовується тут)
    console.log(
      `[showAddTrainingForm] Режим РЕДАГУВАННЯ для плану ID: ${planDataToEdit.id}`
    );
    // effectivePlanData вже встановлено як planDataToEdit на початку
    userPhoneForSetup = planDataToEdit.phone || selectedUserPhone;
    currentEditingPlanId = planDataToEdit.id;
    const ownerUser = usersCache?.find((u) => u.phone === userPhoneForSetup);
    const ownerUserName = ownerUser
      ? ownerUser.full_name || userPhoneForSetup
      : userPhoneForSetup;
    currentFormModeTitle = `Редагування тренування (ID: ${currentEditingPlanId}) для ${ownerUserName}`;

    if (isCopyModeActive) {
      console.log(
        '[showAddTrainingForm] Вхід в режим редагування скасував активний режим копіювання.'
      );
      workoutToCopyData = null;
      isCopyModeActive = false;
    }
  } else {
    // Сценарій 3: СТВОРЕННЯ НОВОГО тренування
    if (!selectedUserPhone) {
      alert(
        "Будь ласка, спочатку оберіть користувача у вкладці 'Профілі' для створення нового тренування."
      );
      proceedWithSetup = false;
    } else {
      console.log(
        `[showAddTrainingForm] Режим СТВОРЕННЯ НОВОГО тренування для: ${selectedUserPhone}`
      );
      // effectivePlanData вже null (бо planDataToEdit був null)
      userPhoneForSetup = selectedUserPhone;
      currentEditingPlanId = null;
      const targetUser = usersCache?.find((u) => u.phone === selectedUserPhone);
      const targetUserName = targetUser
        ? targetUser.full_name || selectedUserPhone
        : selectedUserPhone;
      currentFormModeTitle = `Створення нового тренування для: ${targetUserName}`;

      if (isCopyModeActive || workoutToCopyData) {
        console.log(
          '[showAddTrainingForm] Створення нового тренування, скидання залишків режиму копіювання.'
        );
        workoutToCopyData = null;
        isCopyModeActive = false;
      }
    }
  }

  if (!proceedWithSetup) {
    // Якщо на якомусь етапі вирішили не продовжувати
    return;
  }

  if (!userPhoneForSetup) {
    alert(
      'Помилка: не вдалося визначити користувача для форми тренування. Оберіть користувача.'
    );
    return;
  }

  if (listView) listView.style.display = 'none';
  if (detailsView) detailsView.style.display = 'none';
  if (formView) formView.style.display = 'block';
  if (clearDraftBtn) clearDraftBtn.style.display = 'inline-block';
  if (formTitle) formTitle.textContent = currentFormModeTitle;

  await setupTrainingForm(userPhoneForSetup, effectivePlanData);

  if (loadDraftAfterSetup) {
    console.log('[showAddTrainingForm] Спроба завантажити чернетку...');
    await loadAndApplyWorkoutDraft();
  } else {
    console.log(
      '[showAddTrainingForm] Завантаження чернетки пропущено (через підтверджене копіювання).'
    );
  }

  attachDraftSaveListeners();
}

/**
 * Відображає деталі обраного тренування (АДМІНКА) з коректним макетом та плавним завантаженням GIF.
 * @param {number} planId - ID плану.
 * @param {string} userPhone - Телефон користувача, якому належить план.
 */
/**
 * Відображає деталі обраного тренування (АДМІНКА) з коректним макетом та плавним завантаженням GIF.
 */
/**
 * Відображає деталі обраного тренування (АДМІНКА) з коректним макетом та плавним завантаженням GIF.
 */
async function showAdminWorkoutDetails(planId, userPhone) {
  const listView = document.getElementById(adminWorkoutListViewId);
  const formView = document.getElementById(adminWorkoutFormViewId);
  const detailsView = document.getElementById(adminWorkoutDetailsViewId);
  const detailsContent = document.getElementById(
    'admin-workout-details-content'
  );
  const exercisesContainer = document.getElementById(
    adminWorkoutDetailsExercisesId
  );
  const statusDiv = document.getElementById(adminWorkoutDetailsStatusId);

  if (
    !listView ||
    !formView ||
    !detailsView ||
    !detailsContent ||
    !exercisesContainer ||
    !statusDiv
  ) {
    console.error('showAdminWorkoutDetails: Не знайдено елементи DOM.');
    return;
  }

  listView.style.display = 'none';
  formView.style.display = 'none';
  detailsView.style.display = 'block';
  detailsView.scrollIntoView({ behavior: 'smooth', block: 'start' });
  detailsContent.style.visibility = 'hidden';
  exercisesContainer.innerHTML = '';
  displayStatus(adminWorkoutDetailsStatusId, 'Завантаження деталей...');

  try {
    const { data: plan } = await fetchWithAuth(
      `/admin/trainings/training-plans/${planId}`, // <-- ВИПРАВЛЕНО: Правильний шлях
      {},
      adminWorkoutDetailsStatusId
    );

    // Додаємо логування, щоб бачити, що прийшло з сервера
    console.log('Отримано дані тренування для адміна:', plan);

    // --- ПОЧАТОК ЗМІН: Шукаємо елементи всередині detailsContent ---
    const titleEl = detailsContent.querySelector(
      '#admin-workout-details-title'
    );
    const dateEl = detailsContent.querySelector('#admin-workout-details-date');
    const completionEl = detailsContent.querySelector(
      '#admin-workout-details-completion'
    );
    const descEl = detailsContent.querySelector(
      '#admin-workout-details-description'
    );
    const feedbackEl = detailsContent.querySelector(
      '#admin-workout-details-feedback'
    );
    const durationEl = detailsContent.querySelector(
      '#admin-workout-details-duration'
    );
    const difficultyEl = detailsContent.querySelector(
      '#admin-workout-details-difficulty'
    );
    const cardioEl = detailsContent.querySelector(
      '#admin-workout-details-cardio'
    );
    const caloriesEl = detailsContent.querySelector(
      '#admin-workout-details-calories'
    );
    const aiAnalysisContainer = detailsContent.querySelector(
      '#admin-ai-analysis-container'
    );
    const aiAnalysisTextEl = detailsContent.querySelector(
      '#admin-ai-analysis-text'
    );
    // --- КІНЕЦЬ ЗМІН ---

    // Заповнення полів (логіка залишається та сама)
    if (titleEl) titleEl.textContent = plan.title || 'Без назви';
    if (dateEl)
      dateEl.textContent = !isNaN(new Date(plan.date))
        ? new Date(plan.date).toLocaleDateString('uk-UA')
        : '-';
    if (completionEl) {
      completionEl.textContent = plan.completed ? 'Виконано ✔' : 'Не виконано';
      completionEl.style.color = plan.completed ? 'lightgreen' : 'orange';
      completionEl.style.fontWeight = 'bold';
    }
    if (descEl) {
      descEl.textContent = plan.description || '-';
    }
    if (feedbackEl) {
      feedbackEl.textContent = plan.feedback || 'Відгук відсутній.';
    }
    if (durationEl) {
      durationEl.textContent = plan.training_duration
        ? `${plan.training_duration} хв.`
        : 'не вказано';
    }
    if (difficultyEl) {
      difficultyEl.textContent = plan.difficulty || 'не вказано';
    }
    if (cardioEl) {
      cardioEl.textContent = plan.cardio_duration
        ? `${plan.cardio_duration} хв.`
        : 'не вказано';
    }
    if (caloriesEl) {
      caloriesEl.textContent = plan.calories_burned
        ? `${plan.calories_burned} ккал`
        : 'не вказано';
    }

    // Відображаємо блок з аналізом від Gemini, тільки якщо він існує
    if (aiAnalysisContainer && aiAnalysisTextEl) {
      if (plan.ai_feedback_analysis) {
        aiAnalysisTextEl.textContent = plan.ai_feedback_analysis;
        aiAnalysisContainer.style.display = 'block';
      } else {
        aiAnalysisContainer.style.display = 'none';
      }
    }

    // Очищення та наповнення контейнера вправ
    exercisesContainer.innerHTML = '';
    let planHasExcludedExercise = false;

    if (
      plan.exercises &&
      Array.isArray(plan.exercises) &&
      plan.exercises.length > 0
    ) {
      plan.exercises.sort((a, b) => a.order - b.order);

      plan.exercises.forEach((exercise) => {
        // === КРОК 1: Створення всіх необхідних елементів ===

        // Головний контейнер для однієї вправи
        const exerciseDiv = document.createElement('div');
        exerciseDiv.classList.add('exercise-item', 'readonly');
        exerciseDiv.setAttribute('data-exercise-id', exercise.id);

        if (exercise.is_excluded_by_user === true) {
          exerciseDiv.classList.add('admin-exercise-excluded-by-user');
          planHasExcludedExercise = true;
        }

        // Заголовок вправи
        const header = document.createElement('div');
        header.className = 'exercise-header';
        header.innerHTML = `
                    <span class="exercise-order">${exercise.order}.</span>
                    <h5 class="exercise-name">${exercise.gif.name || '-'}</h5>
                `;

        // Flex-контейнер для двоколонкового вмісту
        const mainContent = document.createElement('div');
        mainContent.className = 'exercise-main-content';

        // Права колонка з деталями
        const details = document.createElement('div');
        details.className = 'exercise-details-content';
        details.innerHTML = `
                    ${exercise.all_weight ? `<p><strong>Заг. вага:</strong> <span class="exercise-all-weight">${exercise.all_weight}</span></p>` : ''}
                    ${exercise.weight_range ? `<p><strong>Діапазон ваг:</strong> <span class="exercise-weight-range">${exercise.weight_range}</span></p>` : ''}
                    ${exercise.emphasis ? '<span class="exercise-emphasis"><strong>Акцент!</strong></span>' : ''}
                    ${exercise.superset ? '<span class="exercise-superset"><strong>Суперсет ⇓</strong></span>' : ''}
                    <h6><strong>Виконання:</strong></h6>
                    ${generateReadOnlySetsTableHTML(exercise)}
                    ${exercise.total_weight === true ? '<span class="total-weight-text">⇑ заг. вага для 2-х ⇑</span>' : ''}
                    ${exercise.total_reps === true ? '<span class="total-reps-text">⇑ заг. к-ть повторень ⇑</span>' : ''}
                    ${exercise.rest_time ? `<p><strong>Відпочинок:</strong> <span class="exercise-rest-time">${formatSecondsToMMSS(exercise.rest_time)}</span></p>` : ''}
                `;

        // === КРОК 2: Збірка структури в правильному порядку ===

        // Спочатку в exerciseDiv додаємо заголовок. Він буде зверху.
        exerciseDiv.appendChild(header);

        // Створюємо та додаємо ліву колонку (GIF) у flex-контейнер
        if (exercise.gif && exercise.gif.filename) {
          const gifContainer = document.createElement('div');
          gifContainer.className = 'gif-container-wrapper loading';
          const hasPreview =
            exercise.gif.preview &&
            exercise.gif.preview !== exercise.gif.filename;

          const previewImg = document.createElement('img');
          previewImg.className = 'gif-preview-view';
          previewImg.src = `https://limaxsport.top/static/gifs/${hasPreview ? exercise.gif.preview : exercise.gif.filename}`;

          const fullGifImg = document.createElement('img');
          fullGifImg.className = 'gif-full-view';

          const loader = document.createElement('div');
          loader.className = 'loader';

          gifContainer.appendChild(previewImg);
          gifContainer.appendChild(fullGifImg);
          gifContainer.appendChild(loader);

          // Додаємо зібраний GIF-блок як першу дитину flex-контейнера
          mainContent.appendChild(gifContainer);

          // Запускаємо логіку завантаження...
          fullGifImg.src = `https://limaxsport.top/static/gifs/${exercise.gif.filename}`;
          const slowLoadTimeoutId = setTimeout(() => {
            if (!fullGifImg.complete) {
              const message = document.createElement('p');
              message.className = 'slow-load-message';
              message.textContent =
                "Поганий інтернет-зв'язок, анімація завантажується.";
              gifContainer.appendChild(message);
            }
          }, 10000);
          fullGifImg.onload = () => {
            clearTimeout(slowLoadTimeoutId);
            const msg = gifContainer.querySelector('.slow-load-message');
            if (msg) msg.remove();
            gifContainer.classList.remove('loading');
            gifContainer.classList.add('is-loaded');
          };
          fullGifImg.onerror = () => {
            clearTimeout(slowLoadTimeoutId);
            gifContainer.classList.remove('loading');
          };
        }

        // Створюємо заголовок-перемикач для опису техніки
        const techniqueToggle = document.createElement('div');
        techniqueToggle.className = 'technique-toggle'; // Додаємо клас для стилізації
        // Створюємо HTML заголовка: назва та стрілочка
        techniqueToggle.innerHTML = `<strong>Техніка виконання:</strong><span class="toggle-arrow">▼</span>`;

        // Створюємо контейнер для самого тексту опису, який будемо ховати/показувати
        const techniqueContent = document.createElement('div');
        techniqueContent.className = 'technique-content'; // За замовчуванням він буде згорнутий завдяки CSS

        // Створюємо елемент для тексту, щоб коректно відобразити переноси рядків
        const descriptionText = document.createElement('div');
        descriptionText.className = 'description-text';
        const description = exercise.gif.description || 'Опис відсутній.';
        // Замінюємо символи нового рядка (\n) на теги <br> для правильного відображення в HTML
        descriptionText.innerHTML = description.replace(/\n/g, '<br>');

        // Додаємо обробник кліку на заголовок
        techniqueToggle.addEventListener('click', () => {
          // При кліку додаємо/видаляємо класи, які керують відображенням
          techniqueToggle.classList.toggle('active');
          techniqueContent.classList.toggle('expanded');
        });

        // Збираємо блок: вкладаємо текст опису в його контейнер
        techniqueContent.appendChild(descriptionText);

        // Додаємо створені елементи на початок правої колонки з деталями
        details.prepend(techniqueContent); // Спочатку контент
        details.prepend(techniqueToggle); // Потім заголовок, щоб він був зверху

        // Додаємо праву колонку (деталі) у flex-контейнер
        mainContent.appendChild(details);

        // Тепер, коли flex-контейнер зібраний, додаємо його в exerciseDiv, ПІСЛЯ заголовка
        exerciseDiv.appendChild(mainContent);

        // Додаємо всю зібрану вправу на сторінку
        exercisesContainer.appendChild(exerciseDiv);
      });
    } else {
      exercisesContainer.innerHTML =
        '<p>Вправи для цього тренування не знайдено.</p>';
    }

    detailsContent.style.visibility = 'visible';

    // Оновлення списку тренувань (без змін)
    const workoutListItem = document.querySelector(
      `#${adminWorkoutListId} .admin-workout-list-item[data-plan-id="${planId}"]`
    );
    if (workoutListItem) {
      workoutListItem.classList.toggle(
        'admin-plan-contains-excluded',
        planHasExcludedExercise
      );
    }
  } catch (error) {
    displayStatus(
      adminWorkoutDetailsStatusId,
      `Помилка завантаження деталей: ${error.message}`,
      true
    );
    console.error(
      `showAdminWorkoutDetails: Помилка для плану ${planId}:`,
      error
    );
    detailsContent.innerHTML = `<p style="color: red;">Не вдалося завантажити деталі: ${error.message}</p>`;
    detailsContent.style.visibility = 'visible';
  }
}

/**
 * Генерує READ-ONLY таблицю підходів/повторень/ваги/часу для деталей тренування (АДМІНКА).
 * Додано стовпці для відображення переваг користувача.
 * @param {object} exercise - Об'єкт вправи з бекенду (вже має містити preferred_weights/reps/time).
 * @returns {string} HTML рядок таблиці.
 */
function generateReadOnlySetsTableHTML(exercise) {
  const numSets = exercise.sets;

  // Якщо немає заданої кількості підходів, або це вправа іншого типу (наприклад, тільки загальна вага)
  if (!numSets || numSets <= 0) {
    if (exercise.all_weight || exercise.weight_range) {
      // Вправа типу "загальна вага" або "діапазон"
      return '<p style="font-style: italic; color: #aaa;">Деталі підходів не застосовуються для цього типу навантаження.</p>';
    }
    return '<p style="font-style: italic; color: #aaa;">Інформація про підходи відсутня (кількість підходів не вказана).</p>';
  }

  // Отримуємо масиви даних, замінюючи null/undefined на порожні масиви для безпечної перевірки
  const repsPlan = exercise.reps || [];
  const weightsPlan = exercise.weights || [];
  const timePlan = exercise.time || []; // Дані для нового поля "час" з плану

  const repsPref = exercise.preferred_reps || [];
  const weightsPref = exercise.preferred_weights || [];
  const timePref = exercise.preferred_time || []; // Дані для нового поля "час" з переваг

  // Визначаємо, які стовпці мають дані і повинні відображатися
  // Стовпець відображається, якщо є хоча б одне значення (не null і не undefined)
  // або в даних плану, або в даних переваг для цього типу (повторень, ваги, часу).
  const showRepsColumn =
    repsPlan.some((val) => val !== null && val !== undefined) ||
    repsPref.some((val) => val !== null && val !== undefined);
  const showWeightsColumn =
    weightsPlan.some((val) => val !== null && val !== undefined) ||
    weightsPref.some((val) => val !== null && val !== undefined);
  const showTimeColumn =
    timePlan.some((val) => val !== null && val !== undefined) ||
    timePref.some((val) => val !== null && val !== undefined);

  // Якщо жоден з типів даних (повторення, вага, час) не має значень,
  // але кількість підходів задана, показуємо відповідне повідомлення.
  if (!showRepsColumn && !showWeightsColumn && !showTimeColumn) {
    return `<p>Кількість підходів: ${numSets}.<br>Деталі по повтореннях, вазі та часу не вказані для цієї вправи.</p>`;
  }

  // Будуємо заголовок таблиці динамічно
  let tableHeaderHTML = '<th>Підхід</th>';
  if (showRepsColumn) {
    tableHeaderHTML +=
      '<th>Повт. (план)</th><th class="pref-col">Повт. (факт)</th>';
  }
  if (showWeightsColumn) {
    tableHeaderHTML +=
      '<th>Вага (план)</th><th class="pref-col">Вага (факт)</th>';
  }
  if (showTimeColumn) {
    tableHeaderHTML +=
      '<th>Час (план)</th><th class="pref-col">Час (факт)</th>';
  }

  let setsTableHTML = `<table class="admin-sets-table readonly">
                            <thead>
                                <tr>${tableHeaderHTML}</tr>
                            </thead>
                            <tbody>`;

  // Генеруємо рядки таблиці
  for (let i = 0; i < numSets; i++) {
    const setNumber = i + 1;
    let rowContentHTML = `<td>${setNumber}</td>`;

    if (showRepsColumn) {
      const repP =
        repsPlan[i] !== null && repsPlan[i] !== undefined ? repsPlan[i] : '-';
      const repF =
        repsPref[i] !== null && repsPref[i] !== undefined ? repsPref[i] : '-';
      rowContentHTML += `<td>${repP}</td><td class="pref-col-val">${repF}</td>`;
    }

    if (showWeightsColumn) {
      // Перевіряємо, чи потрібно відображати стовпці ваги
      const planWeightValue = weightsPlan[i]; // Отримуємо планове значення ваги для поточного підходу
      const factWeightValue = weightsPref[i]; // Отримуємо фактичне/переважне значення ваги

      // Формуємо рядок для відображення планової ваги з "кг"
      const weightP_display =
        planWeightValue !== null && planWeightValue !== undefined
          ? `${planWeightValue} кг` // Додаємо " кг"
          : '-';

      // Формуємо рядок для відображення фактичної/переважної ваги з "кг"
      const weightF_display =
        factWeightValue !== null && factWeightValue !== undefined
          ? `${factWeightValue} кг` // Додаємо " кг"
          : '-';

      rowContentHTML += `<td>${weightP_display}</td><td class="pref-col-val">${weightF_display}</td>`;
    }

    if (showTimeColumn) {
      const timeP_val = timePlan[i];
      const timeF_val = timePref[i];
      // Додаємо "сек" до значень часу, якщо вони є
      const timeP =
        timeP_val !== null && timeP_val !== undefined
          ? `${timeP_val} сек`
          : '-';
      const timeF =
        timeF_val !== null && timeF_val !== undefined
          ? `${timeF_val} сек`
          : '-';
      rowContentHTML += `<td>${timeP}</td><td class="pref-col-val">${timeF}</td>`;
    }

    setsTableHTML += `<tr>${rowContentHTML}</tr>`;
  }

  setsTableHTML += `</tbody></table>`;
  return setsTableHTML;
}

/**
 * Налаштовує форму тренувань для обраного користувача.
 * @param {string} phone - Номер телефону користувача, для якого створюється/редагується тренування.
 * @param {object|null} planData - Дані плану для редагування (якщо це редагування існуючого або дані для копіювання). Null для абсолютно нового тренування.
 * @param {boolean} forceIsNotCopyMode - Прапорець, що примусово вимикає логіку "активного копіювання" (наприклад, при завантаженні чернетки).
 */
async function setupTrainingForm(
  phone,
  planData = null,
  forceIsNotCopyMode = false
) {
  const userNameSpan = document.getElementById('selected-user-name');
  const userPhoneInput = document.getElementById('user-phone');
  const messageDiv = document.getElementById('training-plan-message');
  const form = document.getElementById('add-training-plan-form');
  const exercisesContainer = document.getElementById('exercises-container');

  if (!form) {
    console.error(
      'setupTrainingForm: Форма #add-training-plan-form не знайдена!'
    );
    return;
  }

  if (!exercisesContainer) {
    console.error(
      'setupTrainingForm: Контейнер #exercises-container не знайдено!'
    );
    return;
  }

  // 1. Скидаємо стан форми та лічильники ПЕРЕД заповненням
  if (messageDiv) messageDiv.innerText = '';
  form.reset(); // Скидаємо поля форми
  exercisesContainer.innerHTML = ''; // Очищуємо попередні вправи
  exerciseCounter = 0; // Скидаємо лічильник вправ

  // 2. Встановлюємо телефон користувача (цільового) в data-атрибут форми.
  form.dataset.trainingUserPhone = phone;
  console.log(
    `[setupTrainingForm] Встановлено form.dataset.trainingUserPhone = "${phone}"`
  );

  // 3. Завантажуємо список GIF, дозволених для ЦІЛЬОВОГО користувача ('phone')
  let allowedGifsForTargetUser = null;
  try {
    console.log(
      `[setupTrainingForm] Завантаження дозволених GIF для цільового користувача: ${phone}`
    );
    allowedGifsForTargetUser = await loadGifs(phone);
    console.log(
      `[setupTrainingForm] Завантажено ${allowedGifsForTargetUser?.length || 0} дозволених GIF для користувача ${phone}.`
    );
  } catch (e) {
    console.error(
      `[setupTrainingForm] Помилка завантаження GIF для користувача ${phone}:`,
      e
    );
  }

  // 4. Визначаємо, чи це АКТИВНА ФАЗА КОПІЮВАННЯ
  let isActivelyCopyingNow = false;
  // Критерії для активного копіювання:
  // 1. Режим копіювання НЕ примусово вимкнений (це не завантаження чернетки).
  // 2. Глобальний прапорець isCopyModeActive встановлено.
  // 3. Глобальна змінна workoutToCopyData містить дані.
  // 4. Телефон користувача 'phone', для якого налаштовується форма, є поточним selectedUserPhone (цільовим для копії).
  // 5. У planData передані якісь дані (це мають бути дані з workoutToCopyData).
  //    Умова planData === workoutToCopyData була помилковою через створення копії об'єкта.
  //    Достатньо перевірити, що planData існує в цьому контексті.
  if (
    !forceIsNotCopyMode &&
    isCopyModeActive &&
    workoutToCopyData &&
    phone === selectedUserPhone &&
    planData != null
  ) {
    // Додатково можна перевірити, чи `planData` походить від `workoutToCopyData`,
    // наприклад, порівнявши якийсь унікальний маркер або просто довіряти потоку.
    // Для простоти, якщо всі інші умови виконані і planData не null, вважаємо, що це активне копіювання.
    // Це спрацює, бо showAddTrainingForm передає workoutToCopyData як planData в цьому випадку.
    isActivelyCopyingNow = true;
    console.log(
      `[setupTrainingForm] Форма налаштовується в АКТИВНОМУ РЕЖИМІ КОПІЮВАННЯ для користувача ${phone}.`
    );
  } else if (forceIsNotCopyMode) {
    console.log(
      `[setupTrainingForm] Активний режим копіювання примусово вимкнено (ймовірно, завантаження чернетки).`
    );
    // isActivelyCopyingNow залишається false
  } else if (planData && planData.was_copied_flag) {
    console.log(
      `[setupTrainingForm] Форма заповнюється даними з чернетки, що є результатом копіювання. Активний режим копіювання вимкнено.`
    );
    // isActivelyCopyingNow залишається false
  }
  // В інших випадках isActivelyCopyingNow залишається false.

  // 5. Оновлюємо інформацію про користувача на сторінці
  const targetUserDetails = usersCache?.find((user) => user.phone === phone);
  const fullName = targetUserDetails
    ? targetUserDetails.full_name || phone
    : phone;
  if (userNameSpan) userNameSpan.textContent = fullName;
  if (userPhoneInput) userPhoneInput.value = phone;

  // 6. Заповнюємо загальні поля форми (назва, дата, опис)
  // Цей блок має бути ПІСЛЯ form.reset()
  const trainingTitleInput = form.elements['training-title'];
  const trainingDateInput = form.elements['training-date'];
  const trainingDescriptionInput = form.elements['training-description'];

  if (planData) {
    console.log(
      `[setupTrainingForm] Заповнення загальних полів форми. Активний режим копіювання (isActivelyCopyingNow): ${isActivelyCopyingNow}. ID плану (якщо є): ${planData.id}, Користувач: ${phone}`
    );

    if (trainingTitleInput) {
      trainingTitleInput.value = planData.title || '';
    }

    if (trainingDateInput) {
      try {
        if (isActivelyCopyingNow) {
          // Використовуємо правильний прапорець
          trainingDateInput.value = '';
          console.log(
            '[setupTrainingForm] Активний режим копіювання: Поле дати очищено.'
          );
        } else if (planData.date) {
          trainingDateInput.value = new Date(planData.date)
            .toISOString()
            .split('T')[0];
        } else {
          trainingDateInput.value = '';
        }
      } catch (e) {
        console.error('Помилка форматування дати для плану:', planData.date, e);
        trainingDateInput.value = '';
      }
    }

    if (trainingDescriptionInput) {
      trainingDescriptionInput.value = planData.description || '';
      autoResize(trainingDescriptionInput);
    }

    // Додаємо вправи до форми
    if (planData.exercises && planData.exercises.length > 0) {
      for (const exercise of planData.exercises.sort(
        (a, b) => a.order - b.order
      )) {
        await addExerciseToFormWithData(
          exercise,
          phone,
          isActivelyCopyingNow,
          allowedGifsForTargetUser
        );
      }
    } else {
      console.log(
        `[setupTrainingForm] Дані плану (ID: ${planData.id || 'копія'}) не містять вправ. Додавання порожньої вправи. Активний режим копіювання: ${isActivelyCopyingNow}`
      );
      await handleAddExercise(
        phone,
        isActivelyCopyingNow,
        allowedGifsForTargetUser
      );
    }
  } else {
    // Абсолютно новий план (planData === null)
    console.log(
      `[setupTrainingForm] Режим створення НОВОГО тренування для користувача: ${phone}`
    );
    if (trainingTitleInput) trainingTitleInput.value = ''; // Для нового плану назва теж порожня
    if (trainingDateInput) trainingDateInput.value = ''; // Для нового плану дата теж порожня
    if (trainingDescriptionInput) trainingDescriptionInput.value = ''; // І опис
    // isActivelyCopyingNow тут буде false
    await handleAddExercise(phone, false, allowedGifsForTargetUser);
  }
  // ... (виклик saveWorkoutDraft() тут не потрібен)
}

/**
 * NEW: Функція для завантаження тренування для редагування.
 */
async function loadWorkoutForEditing(planId, userPhone) {
  const statusDivId = adminWorkoutListStatusId; // Можна використовувати статус зі списку або форми
  displayStatus(
    statusDivId,
    `Завантаження тренування ID: ${planId} для редагування...`
  );
  try {
    const { data: planData } = await fetchWithAuth(
      `/admin/trainings/training-plans/${planId}`, // <-- ВИПРАВЛЕНО: Правильний шлях
      {},
      statusDivId
    );
    if (planData) {
      showAddTrainingForm(planData); // Показуємо форму та передаємо дані
      displayStatus(statusDivId, ''); // Очищуємо статус після завантаження
    } else {
      throw new Error('Не вдалося завантажити дані тренування.');
    }
  } catch (error) {
    console.error(
      `Помилка завантаження тренування ID ${planId} для редагування:`,
      error
    );
    displayStatus(statusDivId, `Помилка: ${error.message}`, true, 5000);
  }
}

/**
 * ФІНАЛЬНА ВЕРСІЯ: Додає блок вправи з існуючими даними та коректно ініціалізує браузер GIF.
 */
async function addExerciseToFormWithData(
  exerciseData,
  trainingUserPhone,
  isInCopyMode,
  allowedGifsForTargetUser
) {
  exerciseCounter++;
  const template = document
    .getElementById('exercise-template')
    ?.content.cloneNode(true);
  if (!template) return;
  const exerciseFieldset = template.querySelector('.exercise');
  if (!exerciseFieldset) {
    alert('Помилка: Некоректний шаблон вправи.');
    return;
  }
  exerciseFieldset.classList.add('exercise-item-in-form');

  // --- Кнопка видалення вправи ---
  const deleteExerciseBtn = document.createElement('button');
  deleteExerciseBtn.type = 'button';
  deleteExerciseBtn.innerHTML = '❌';
  deleteExerciseBtn.classList.add('delete-exercise-btn');
  deleteExerciseBtn.title = 'Видалити цю вправу';
  deleteExerciseBtn.addEventListener('click', () => {
    if (confirm('Ви впевнені, що хочете видалити цю вправу з форми?')) {
      exerciseFieldset.remove();
      document
        .querySelectorAll('#exercises-container .exercise .exercise-number')
        .forEach((span, idx) => {
          span.textContent = idx + 1;
        });
      exerciseCounter = document.querySelectorAll(
        '#exercises-container .exercise'
      ).length;
      saveWorkoutDraft();
    }
  });
  exerciseFieldset.appendChild(deleteExerciseBtn);

  // --- Номер та порядок вправи ---
  const exerciseNumberSpan = exerciseFieldset.querySelector('.exercise-number');
  if (exerciseNumberSpan) exerciseNumberSpan.textContent = exerciseCounter;
  const orderInput = exerciseFieldset.querySelector('.order-input');
  if (orderInput) orderInput.value = exerciseData.order || exerciseCounter;

  // --- Отримуємо посилання на всі елементи DOM ---
  const selectedGifImg = exerciseFieldset.querySelector('.selected-gif');
  const gifIdInput = exerciseFieldset.querySelector('.gif-id-input');
  const nameInput = exerciseFieldset.querySelector('.name-input');
  const descriptionInput = exerciseFieldset.querySelector('.description-input');
  const originalFilenameInput = exerciseFieldset.querySelector(
    '.original-gif-filename-input'
  );
  // ... (решта посилань на елементи) ...
  const emphasisInput = exerciseFieldset.querySelector('.emphasis-input');
  const supersetInput = exerciseFieldset.querySelector('.superset-input');
  const allWeightInput = exerciseFieldset.querySelector('.all-weight');
  const weightRangeFromInput =
    exerciseFieldset.querySelector('.weight-range-from');
  const weightRangeToInput = exerciseFieldset.querySelector('.weight-range-to');
  const totalWeightInput = exerciseFieldset.querySelector(
    '.total-weight-input'
  );
  const totalRepsInput = exerciseFieldset.querySelector('.total-reps-input');
  const restMinutesInput = exerciseFieldset.querySelector('.rest-time-minutes');
  const restSecondsInput = exerciseFieldset.querySelector('.rest-time-seconds');
  const setsInput = exerciseFieldset.querySelector('.sets-input');
  const setsTableContainer = exerciseFieldset.querySelector(
    '.sets-table-container'
  );

  // Показуємо правильні контейнери
  exerciseFieldset.querySelector('.gif-selector-container').style.display =
    'none';
  const selectedGifContainer = exerciseFieldset.querySelector(
    '.selected-gif-container'
  );
  const exerciseDetailsFields = exerciseFieldset.querySelector(
    '.exercise-details-fields'
  );

  // 1. Заповнення даних про GIF
  if (exerciseData.gif && exerciseData.gif.id) {
    if (selectedGifContainer) selectedGifContainer.style.display = 'block';
    if (exerciseDetailsFields) exerciseDetailsFields.style.display = 'block';

    if (gifIdInput) gifIdInput.value = exerciseData.gif.id;
    // *** ВАЖЛИВО: Беремо name та description з самої вправи, якщо вони є (збережені раніше),
    // інакше - з довідника GIF. Це дозволить бачити збережені зміни.
    if (nameInput)
      nameInput.value = exerciseData.name || exerciseData.gif.name || '';
    if (descriptionInput)
      descriptionInput.value =
        exerciseData.description || exerciseData.gif.description || '';

    if (exerciseData.gif.filename) {
      if (selectedGifImg) {
        selectedGifImg.src = `https://limaxsport.top/static/gifs/${exerciseData.gif.filename}`;
        selectedGifImg.style.display = 'block';
      }
      if (originalFilenameInput)
        originalFilenameInput.value = exerciseData.gif.filename;
    }
  } else {
    // Якщо GIF не обрано (напр. з чернетки) - показуємо браузер GIF
    if (selectedGifContainer) selectedGifContainer.style.display = 'none';
    if (exerciseDetailsFields) exerciseDetailsFields.style.display = 'none';
    initializeAdminGifBrowser(exerciseFieldset, trainingUserPhone);
  }

  // ... (решта коду заповнення полів: чекбокси, вага, сети і т.д. залишається БЕЗ ЗМІН)
  if (emphasisInput) emphasisInput.checked = exerciseData.emphasis || false;
  if (supersetInput) supersetInput.checked = exerciseData.superset || false;
  if (totalWeightInput)
    totalWeightInput.checked = exerciseData.total_weight || false;
  if (totalRepsInput) totalRepsInput.checked = exerciseData.total_reps || false;
  if (allWeightInput) {
    allWeightInput.value = exerciseData.all_weight || '';
  }
  if (
    exerciseData.weight_range &&
    typeof exerciseData.weight_range === 'string'
  ) {
    if (weightRangeFromInput && weightRangeToInput) {
      const match = exerciseData.weight_range.match(/від\s(.+?)\sдо\s(.+)/i);
      if (match && match.length === 3) {
        weightRangeFromInput.value = match[1].trim();
        weightRangeToInput.value = match[2].trim();
      } else {
        weightRangeFromInput.value = '';
        weightRangeToInput.value = '';
      }
    }
  } else {
    if (weightRangeFromInput) weightRangeFromInput.value = '';
    if (weightRangeToInput) weightRangeToInput.value = '';
  }
  if (exerciseData.rest_time != null && exerciseData.rest_time > 0) {
    if (restMinutesInput && restSecondsInput) {
      restMinutesInput.value = Math.floor(exerciseData.rest_time / 60);
      restSecondsInput.value = exerciseData.rest_time % 60;
    }
  } else {
    if (restMinutesInput) restMinutesInput.value = '';
    if (restSecondsInput) restSecondsInput.value = '';
  }
  if (setsInput && setsTableContainer) {
    let numSetsToUse = 0;
    let dataToFill = { reps: [], weights: [], time: [] };

    // --- ПОЧАТОК НОВОЇ, БІЛЬШ НАДІЙНОЇ ЛОГІКИ ---

    if (isInCopyMode) {
      // РЕЖИМ КОПІЮВАННЯ: Намагаємось завантажити дані ЦІЛЬОВОГО користувача
      let preferencesFound = false; // Прапорець, чи знайшли ми дані
      const currentExerciseGifId = exerciseData.gif?.id;

      if (trainingUserPhone && currentExerciseGifId) {
        try {
          const { data: preferences } = await fetchWithAuth(
            `/admin/trainings/${trainingUserPhone}/preferences/${currentExerciseGifId}`
          );

          if (
            preferences &&
            Array.isArray(preferences.reps) &&
            preferences.reps.length > 0
          ) {
            // Успіх! Знайшли дані цільового користувача.
            numSetsToUse = preferences.reps.length;
            dataToFill = {
              reps: preferences.reps || [],
              weights: preferences.weights || [],
              time: preferences.time || [],
            };
            preferencesFound = true;

            // ДОДАТКОВО: Позначимо, що дані успішно завантажені
            setsTableContainer
              .closest('.exercise')
              ?.classList.add('copied-with-preferences');
          }
        } catch (error) {
          console.error(`[CopyMode] Помилка завантаження переваг:`, error);
        }
      }

      // Якщо переваги НЕ були знайдені (або була помилка)
      if (!preferencesFound) {
        // Беремо кількість підходів з тренування-джерела, але дані залишаємо ПОРОЖНІМИ
        numSetsToUse = exerciseData.sets || 0;
        dataToFill = { reps: [], weights: [], time: [] }; // <-- Ключовий момент!
      }
    } else {
      // ЦЕ НЕ РЕЖИМ КОПІЮВАННЯ: Просто завантажуємо дані з чернетки або збереженого тренування
      numSetsToUse = exerciseData.sets || 0;
      dataToFill = {
        reps: exerciseData.reps || [],
        weights: exerciseData.weights || [],
        time: exerciseData.time || [],
      };
    }
    setsInput.value = numSetsToUse;
    generateSetsTable(numSetsToUse, setsTableContainer);
    if (numSetsToUse > 0) {
      const rS = setsTableContainer.querySelectorAll('.reps-select');
      const wS = setsTableContainer.querySelectorAll('.weight-select');
      const tS = setsTableContainer.querySelectorAll('.time-select');
      for (let i = 0; i < numSetsToUse; i++) {
        if (rS[i]) rS[i].value = dataToFill.reps[i] ?? '';
        if (wS[i]) wS[i].value = dataToFill.weights[i] ?? '';
        if (tS[i]) tS[i].value = dataToFill.time[i] ?? '';
      }
    }
  }
  if (
    isInCopyMode &&
    exerciseData.gif?.id &&
    Array.isArray(allowedGifsForTargetUser)
  ) {
    // Перевіряємо, чи ID поточної вправи є у списку дозволених для цільового юзера
    const isAllowed = allowedGifsForTargetUser.some(
      (gif) => gif.id === exerciseData.gif.id
    );

    // Якщо вправи немає у списку дозволених
    if (!isAllowed) {
      // Додаємо CSS-клас для візуального виділення (наприклад, червоний фон)
      exerciseFieldset.classList.add('copied-exercise-is-excluded');
      console.warn(
        `[CopyMode] Вправа GIF ID:${exerciseData.gif.id} ("${
          exerciseData.gif?.name || nameInput?.value || 'N/A'
        }") ВИКЛЮЧЕНА для користувача ${trainingUserPhone}.`
      );

      // Створюємо та додаємо текстове попередження
      const warningMsgElement = document.createElement('p');
      warningMsgElement.classList.add('js-copied-exercise-warning-message');
      warningMsgElement.innerHTML =
        '<strong>УВАГА:</strong> Ця вправа виключена для обраного користувача!';
      warningMsgElement.style.color = 'red';
      warningMsgElement.style.fontWeight = 'normal';
      warningMsgElement.style.fontSize = '0.9em';
      warningMsgElement.style.textAlign = 'left';
      warningMsgElement.style.padding = '5px 0px';
      warningMsgElement.style.margin = '5px 0 10px 0';

      // Вставляємо попередження після поля з назвою вправи
      if (nameInput) {
        if (nameInput.nextSibling) {
          nameInput.parentNode.insertBefore(
            warningMsgElement,
            nameInput.nextSibling
          );
        } else {
          nameInput.parentNode.appendChild(warningMsgElement);
        }
      }
    }
  }

  // *** КЛЮЧОВА ЗМІНА №1 ***
  // Додаємо обробник на кнопку "Змінити вправу", яка тепер є в шаблоні
  const changeBtn = exerciseFieldset.querySelector('.change-exercise-btn');
  if (changeBtn) {
    changeBtn.addEventListener('click', () => {
      initializeAdminGifBrowser(exerciseFieldset, trainingUserPhone);
    });
  }

  document.getElementById('exercises-container')?.appendChild(exerciseFieldset);
  if (nameInput && nameInput.tagName.toLowerCase() === 'textarea')
    autoResize(nameInput);
  if (descriptionInput && descriptionInput.tagName.toLowerCase() === 'textarea')
    autoResize(descriptionInput);
}

/**
 * НОВА УНІВЕРСАЛЬНА ФУНКЦІЯ: Ініціалізує та керує браузером GIF,
 * використовуючи твою стару логіку навігації по всіх рівнях папок.
 */
async function initializeAdminGifBrowser(exerciseFieldset, userPhone) {
  const selectorContainer = exerciseFieldset.querySelector(
    '.gif-selector-container'
  );
  if (!selectorContainer) return;

  // Робимо браузер видимим
  selectorContainer.style.display = 'block';

  // Якщо браузер вже ініціалізовано, не дублюємо логіку
  if (selectorContainer.dataset.initialized === 'true') return;

  const gifGrid = exerciseFieldset.querySelector('.gif-grid');
  const pathDisplay = exerciseFieldset.querySelector('.path-display');
  // Контейнер для кнопок папок та навігації
  const folderButtonsContainer =
    exerciseFieldset.querySelector('.folder-buttons');

  gifGrid.innerHTML = '<p>Завантаження GIF...</p>';
  const gifsForBrowser = await loadGifs(userPhone);

  if (!gifsForBrowser || gifsForBrowser.length === 0) {
    gifGrid.innerHTML = '<p>GIF-файли не знайдено.</p>';
    return;
  }

  // Функція для отримання вмісту поточної директорії
  const getContentsForPath = (pathArray) => {
    const subdirectories = new Set();
    const files = [];
    const pathDepth = pathArray.length;

    gifsForBrowser.forEach((gif) => {
      const gifParts = gif.filename.split('/').slice(1); // Ігноруємо телефон адміна
      if (gifParts.length <= pathDepth) return;

      // Перевіряємо, чи збігається шлях
      let prefixMatches = pathArray.every((part, i) => gifParts[i] === part);
      if (!prefixMatches) return;

      const partsAfterPrefix = gifParts.length - pathDepth;
      if (partsAfterPrefix > 1) {
        // Це піддиректорія
        subdirectories.add(gifParts[pathDepth]);
      } else if (partsAfterPrefix === 1) {
        // Це файл у поточній директорії
        files.push(gif);
      }
    });
    return { subdirectories: Array.from(subdirectories).sort(), files };
  };

  let currentPath = []; // Поточний шлях ["папка", "підпапка", ...]

  const renderBrowser = (pathArray) => {
    folderButtonsContainer.innerHTML = '';
    gifGrid.innerHTML = '';
    const { subdirectories, files } = getContentsForPath(pathArray);

    // Створюємо "хлібні крихти" та кнопку "Назад"
    let breadcrumbsHTML = `<span class="path-segment" data-path="">📁 Мої вправи</span>`;
    let tempPath = [];
    pathArray.forEach((segment) => {
      tempPath.push(segment);
      breadcrumbsHTML += ` / <span class="path-segment" data-path="${tempPath.join('/')}">${segment}</span>`;
    });
    pathDisplay.innerHTML = breadcrumbsHTML;

    if (pathArray.length > 0) {
      const backButton = document.createElement('button');
      backButton.className = 'back-btn';
      backButton.textContent = '⬅️ Назад';
      folderButtonsContainer.appendChild(backButton);
    }

    // Відображаємо кнопки піддиректорій
    subdirectories.forEach((dir) => {
      const button = document.createElement('button');
      button.className = 'directory-btn';
      button.dataset.dir = dir;
      button.textContent = dir;
      folderButtonsContainer.appendChild(button);
    });

    // Відображаємо файли GIF
    if (files.length > 0) {
      displayGifs(files, exerciseFieldset);
      gifGrid.style.display = 'grid';
    } else {
      gifGrid.style.display = 'none';
      if (subdirectories.length === 0) {
        gifGrid.innerHTML = '<p>Тут порожньо.</p>';
        gifGrid.style.display = 'block';
      }
    }
  };

  // Єдиний обробник кліків для навігації
  selectorContainer.addEventListener('click', (e) => {
    const target = e.target;
    if (target.matches('.directory-btn')) {
      currentPath.push(target.dataset.dir);
      renderBrowser(currentPath);
    } else if (target.matches('.back-btn')) {
      currentPath.pop();
      renderBrowser(currentPath);
    } else if (target.matches('.path-segment')) {
      const pathToGo = target.dataset.path.split('/').filter((p) => p);
      currentPath = pathToGo;
      renderBrowser(currentPath);
    }
  });

  renderBrowser(currentPath); // Перший рендер
  selectorContainer.dataset.initialized = 'true';
}

/**
 * Асинхронно завантажує список GIF з сервера.
 * - Якщо targetUserPhone НЕ надано, завантажує повний список GIF поточного адміна (з кешуванням).
 * - Якщо targetUserPhone НАДАНО, завантажує відфільтрований список GIF для цього користувача
 * (без використання та оновлення глобального gifsCache).
 * @param {string | null} targetUserPhone - Необов'язковий номер телефону користувача,
 * для якого потрібно відфільтрувати GIF-файли.
 * @returns {Promise<Array>} Масив об'єктів GIF. Повертає порожній масив у разі помилки.
 */
async function loadGifs(targetUserPhone = null) {
  const adminPhone = localStorage.getItem('admin_phone')?.replace('+', '');
  if (!adminPhone) {
    alert(
      'Помилка: Номер телефону адміністратора не знайдено. Авторизуйтесь повторно.'
    );
    console.error('loadGifs: admin_phone не знайдено в localStorage.');
    return [];
  }

  let relativeApiUrl = `/admin/trainings/gifs/${adminPhone}`; // Завжди запитуємо GIF поточного адміна

  if (
    targetUserPhone &&
    typeof targetUserPhone === 'string' &&
    targetUserPhone.trim() !== ''
  ) {
    // Якщо є targetUserPhone, додаємо його як параметр для фільтрації на бекенді
    relativeApiUrl += `?target_user_phone=${encodeURIComponent(targetUserPhone.trim())}`;
    console.log(
      `loadGifs: Запит ВІДФІЛЬТРОВАНОГО списку GIF для користувача ${targetUserPhone}. Відносний URL: ${relativeApiUrl}`
    );
    try {
      // Для відфільтрованого списку НЕ використовуємо глобальний gifsCache,
      // оскільки він призначений для повного списку адміна.
      const { data: filteredGifs } = await fetchWithAuth(relativeApiUrl);
      console.log(
        `loadGifs: Відфільтровані GIF для користувача ${targetUserPhone} завантажено. Кількість: ${filteredGifs?.length || 0}`
      );
      return filteredGifs || [];
    } catch (error) {
      alert(
        `Не вдалося завантажити відфільтрований список GIF для користувача ${targetUserPhone}.`
      );
      console.error(
        `loadGifs: Помилка завантаження відфільтрованих GIF для ${targetUserPhone}:`,
        error
      );
      return [];
    }
  } else {
    // Завантаження ПОВНОГО списку GIF поточного адміна (з використанням кешу)
    if (gifsCache) {
      console.log(
        'loadGifs: Повний список GIF адміна завантажено з глобального кешу.'
      );
      return gifsCache;
    }
    console.log(
      `loadGifs: Запит ПОВНОГО списку GIF адміна ${adminPhone}. Відносний URL: ${relativeApiUrl}`
    );
    try {
      const { data: allAdminGifs } = await fetchWithAuth(relativeApiUrl);
      gifsCache = allAdminGifs || []; // Оновлюємо глобальний кеш
      console.log(
        `loadGifs: Повний список GIF адміна завантажено та кешовано. Кількість: ${gifsCache.length}`
      );
      return gifsCache;
    } catch (error) {
      alert('Не вдалося завантажити повний список GIF-файлів.');
      console.error(
        `loadGifs: Помилка завантаження повного списку GIF адміна ${adminPhone}:`,
        error
      );
      gifsCache = null;
      return [];
    }
  }
}

function displayGifs(gifs, exerciseFieldset) {
  const gifGrid = exerciseFieldset.querySelector('.gif-grid');
  if (!gifGrid) {
    console.error(
      'displayGifs: Не знайдено елемент .gif-grid у fieldset:',
      exerciseFieldset
    );
    return;
  }

  gifGrid.innerHTML = '';
  if (!gifs || gifs.length === 0) {
    gifGrid.innerHTML = '<p>GIF не знайдено для цього розділу.</p>';
    gifGrid.style.display = 'grid';
    return;
  }

  gifs.forEach((gif) => {
    const gifItem = document.createElement('div');
    gifItem.className = 'gif-item';

    const hasPreview = gif.preview && gif.preview !== gif.filename;
    const previewImg = document.createElement('img');
    previewImg.className = 'gif-preview';
    previewImg.src = `https://limaxsport.top/static/gifs/${hasPreview ? gif.preview : gif.filename}`;
    previewImg.alt = gif.name || "Прев'ю вправи";
    previewImg.loading = 'lazy';

    const fullGifImg = document.createElement('img');
    fullGifImg.className = 'gif-full';
    fullGifImg.alt = gif.name || 'Анімація вправи';

    const loader = document.createElement('div');
    loader.className = 'loader';

    const nameLabel = document.createElement('span');
    nameLabel.textContent = gif.name || '(без назви)';
    nameLabel.className = 'gif-name-label';

    const gifData = {
      id: gif.id,
      gifSrc: `https://limaxsport.top/static/gifs/${gif.filename}`,
      name: gif.name || '',
      description: gif.description || '',
      originalFilename: gif.filename,
    };

    let isAnimated = !hasPreview;
    if (!hasPreview) {
      fullGifImg.src = gifData.gifSrc;
      gifItem.classList.add('is-loaded');
    }

    gifItem.addEventListener('click', async (event) => {
      event.stopPropagation();

      if (!isAnimated) {
        isAnimated = true;
        let slowLoadTimeoutId = null;
        slowLoadTimeoutId = setTimeout(() => {
          const message = document.createElement('p');
          message.className = 'slow-load-message';
          message.textContent =
            "Поганий інтернет-зв'язок, анімація завантажується.";
          gifItem.appendChild(message);
        }, 10000);
        gifItem.classList.add('loading');
        fullGifImg.src = gifData.gifSrc;
        fullGifImg.onload = () => {
          clearTimeout(slowLoadTimeoutId);
          const existingMessage = gifItem.querySelector('.slow-load-message');
          if (existingMessage) existingMessage.remove();
          gifItem.classList.remove('loading');
          gifItem.classList.add('is-loaded');
        };
        fullGifImg.onerror = () => {
          clearTimeout(slowLoadTimeoutId);
          const existingMessage = gifItem.querySelector('.slow-load-message');
          if (existingMessage) existingMessage.remove();
          console.error('Не вдалося завантажити GIF:', gifData.gifSrc);
          gifItem.classList.remove('loading');
        };
      } else {
        const currentExerciseFieldset = gifItem.closest('.exercise');
        if (!currentExerciseFieldset) return;

        const selectedGifImg =
          currentExerciseFieldset.querySelector('.selected-gif');
        const gifIdInput =
          currentExerciseFieldset.querySelector('.gif-id-input');
        const nameInput = currentExerciseFieldset.querySelector('.name-input');
        const descriptionInput =
          currentExerciseFieldset.querySelector('.description-input');
        const originalFilenameInput = currentExerciseFieldset.querySelector(
          '.original-gif-filename-input'
        );
        const setsInput = currentExerciseFieldset.querySelector('.sets-input');
        const setsTableContainer = currentExerciseFieldset.querySelector(
          '.sets-table-container'
        );

        if (
          !selectedGifImg ||
          !gifIdInput ||
          !nameInput ||
          !descriptionInput ||
          !originalFilenameInput ||
          !setsInput ||
          !setsTableContainer
        ) {
          console.error('Один або декілька елементів вправи не знайдено.');
          return;
        }

        selectedGifImg.src = gifData.gifSrc;
        selectedGifImg.style.display = 'block';
        gifIdInput.value = gifData.id;
        nameInput.value = gifData.name;
        descriptionInput.value = gifData.description;

        // *** КЛЮЧОВА ЗМІНА ***
        // Даємо браузеру мить на "перетравлення" нового тексту перед розрахунком висоти
        setTimeout(() => {
          autoResize(nameInput);
          autoResize(descriptionInput);
        }, 500);
        originalFilenameInput.value = gifData.originalFilename;

        const selectBtn =
          currentExerciseFieldset.querySelector('.select-gif-btn');
        if (selectBtn) selectBtn.textContent = 'Змінити GIF';

        const formElement = document.getElementById('add-training-plan-form');
        const phoneForPreferences = formElement
          ? formElement.dataset.trainingUserPhone
          : null;

        if (phoneForPreferences && gifData.id) {
          try {
            const { data: preferences } = await fetchWithAuth(
              `/admin/trainings/${phoneForPreferences}/preferences/${gifData.id}`
            );

            let repsData = preferences.reps;
            let weightsData = preferences.weights;
            let timeData = preferences.time;

            if (typeof repsData === 'string')
              repsData = JSON.parse(repsData || '[]');
            if (typeof weightsData === 'string')
              weightsData = JSON.parse(weightsData || '[]');
            if (typeof timeData === 'string')
              timeData = JSON.parse(timeData || '[]');

            if (preferences && Array.isArray(repsData) && repsData.length > 0) {
              const numSetsFromPrefs = repsData.length;
              setsInput.value = numSetsFromPrefs;
              generateSetsTable(numSetsFromPrefs, setsTableContainer);
              const repsSelects =
                setsTableContainer.querySelectorAll('.reps-select');
              const weightsSelects =
                setsTableContainer.querySelectorAll('.weight-select');
              const timeSelects =
                setsTableContainer.querySelectorAll('.time-select');
              for (let i = 0; i < numSetsFromPrefs; i++) {
                if (repsSelects[i]) repsSelects[i].value = repsData[i] ?? '';
                if (weightsSelects[i])
                  weightsSelects[i].value = weightsData?.[i] ?? '';
                if (timeSelects[i]) timeSelects[i].value = timeData?.[i] ?? '';
              }
            } else {
              const currentNumSets = parseInt(setsInput.value) || 0;
              generateSetsTable(currentNumSets, setsTableContainer);
            }
          } catch (error) {
            console.error(
              `Помилка отримання переваг для GIF ${gifData.id}:`,
              error
            );
            const currentNumSets = parseInt(setsInput.value) || 0;
            generateSetsTable(currentNumSets, setsTableContainer);
          }
        } else {
          console.warn('Телефон клієнта не знайдено, запит переваг пропущено.');
          const currentNumSets = parseInt(setsInput.value) || 0;
          generateSetsTable(currentNumSets, setsTableContainer);
        }

        const selectorContainer = currentExerciseFieldset.querySelector(
          '.gif-selector-container'
        );
        const selectedGifContainer = currentExerciseFieldset.querySelector(
          '.selected-gif-container'
        );
        const exerciseDetailsFields = currentExerciseFieldset.querySelector(
          '.exercise-details-fields'
        );

        if (selectorContainer) selectorContainer.style.display = 'none';
        if (selectedGifContainer) selectedGifContainer.style.display = 'block';
        if (exerciseDetailsFields)
          exerciseDetailsFields.style.display = 'block';

        if (selectedGifImg)
          selectedGifImg.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
          });
        saveWorkoutDraft();
      }
    });

    gifItem.appendChild(previewImg);
    gifItem.appendChild(fullGifImg);
    gifItem.appendChild(loader);

    const gridCell = document.createElement('div');
    gridCell.className = 'grid-cell';
    gridCell.appendChild(gifItem);
    gridCell.appendChild(nameLabel);

    gifGrid.appendChild(gridCell);
  });

  gifGrid.style.display = 'grid';
}

/**
 * Генерує таблицю для вводу підходів/повторень/ваги.
 * @param {number} sets - Кількість підходів.
 * @param {HTMLElement} container - Контейнер для таблиці.
 */
function generateSetsTable(sets, container) {
  if (!container) return;
  container.innerHTML = ''; // Очищуємо контейнер

  if (!sets || sets <= 0) return; // Не генеруємо, якщо підходів 0 або менше

  const table = document.createElement('table');
  table.classList.add('admin-sets-table'); // Додаємо клас для стилізації

  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  headerRow.innerHTML =
    '<th>Підхід</th><th>Повторення</th><th>Вага (кг)</th><th>Час (сек)</th>';

  const tbody = table.createTBody();
  for (let i = 1; i <= sets; i++) {
    const row = tbody.insertRow();
    row.innerHTML = `
            <td>${i}</td>
            <td><select name="reps[]" class="reps-select">${repsOptionsWithPlaceholderHTML}</select></td>
            <td><select name="weights[]" class="weight-select">${weightOptionsWithPlaceholderHTML}</select></td>
            <td><select name="time[]" class="time-select">${timeOptionsWithPlaceholderHTML}</select></td> 
        `;
  }
  container.appendChild(table);
}

/**
 * ФІНАЛЬНА ВЕРСІЯ: Додає новий блок вправи і одразу запускає браузер GIF.
 */
async function handleAddExercise(trainingUserPhone) {
  exerciseCounter++;
  const template = document
    .getElementById('exercise-template')
    ?.content.cloneNode(true);
  if (!template) return;

  const exerciseFieldset = template.querySelector('.exercise');
  if (!exerciseFieldset) return;
  exerciseFieldset.classList.add('exercise-item-in-form');

  // ... (твій код для кнопки видалення, номера та порядку вправи залишається БЕЗ ЗМІН) ...
  const deleteExerciseBtn = document.createElement('button');
  deleteExerciseBtn.type = 'button';
  deleteExerciseBtn.innerHTML = '❌';
  deleteExerciseBtn.classList.add('delete-exercise-btn');
  deleteExerciseBtn.title = 'Видалити цю вправу';
  deleteExerciseBtn.addEventListener('click', () => {
    if (confirm('Ви впевнені, що хочете видалити цю вправу з форми?')) {
      exerciseFieldset.remove();
      document
        .querySelectorAll('#exercises-container .exercise .exercise-number')
        .forEach((span, idx) => {
          span.textContent = idx + 1;
        });
      exerciseCounter = document.querySelectorAll(
        '#exercises-container .exercise'
      ).length;
      saveWorkoutDraft();
    }
  });
  exerciseFieldset.appendChild(deleteExerciseBtn);
  const exerciseNumberSpan = exerciseFieldset.querySelector('.exercise-number');
  if (exerciseNumberSpan) exerciseNumberSpan.textContent = exerciseCounter;
  const orderInput = exerciseFieldset.querySelector('.order-input');
  if (orderInput) orderInput.value = exerciseCounter;

  const setsInput = exerciseFieldset.querySelector('.sets-input');
  const setsTableContainer = exerciseFieldset.querySelector(
    '.sets-table-container'
  );
  if (setsInput && setsTableContainer) {
    generateSetsTable(parseInt(setsInput.value) || 0, setsTableContainer);
  }

  document.getElementById('exercises-container')?.appendChild(exerciseFieldset);

  // Знаходимо текстові поля у щойно створеній вправі
  const newNameInput = exerciseFieldset.querySelector('.name-input');
  const newDescriptionInput =
    exerciseFieldset.querySelector('.description-input');

  // Перевіряємо, чи існує функція autoResize, щоб уникнути помилок
  if (typeof autoResize === 'function') {
    // Додаємо обробник події 'input' для поля НАЗВИ
    if (newNameInput) {
      newNameInput.addEventListener('input', () => autoResize(newNameInput));
    }
    // Додаємо обробник події 'input' для поля ОПИСУ
    if (newDescriptionInput) {
      newDescriptionInput.addEventListener('input', () =>
        autoResize(newDescriptionInput)
      );
    }
  }

  // *** КЛЮЧОВА ЗМІНА №2 ***
  // Приховуємо блок обраного GIF та поля, і одразу запускаємо браузер вибору
  const selectedGifContainer = exerciseFieldset.querySelector(
    '.selected-gif-container'
  );
  const exerciseDetailsFields = exerciseFieldset.querySelector(
    '.exercise-details-fields'
  );
  if (selectedGifContainer) selectedGifContainer.style.display = 'none';
  if (exerciseDetailsFields) exerciseDetailsFields.style.display = 'none';

  initializeAdminGifBrowser(exerciseFieldset, trainingUserPhone);

  // Додаємо обробник на кнопку "Змінити вправу" на майбутнє
  const changeBtn = exerciseFieldset.querySelector('.change-exercise-btn');
  if (changeBtn) {
    changeBtn.addEventListener('click', () => {
      initializeAdminGifBrowser(exerciseFieldset, trainingUserPhone);
    });
  }
}

/**
 * Обробляє відправку форми створення/оновлення тренування.
 * ОНОВЛЕНО: Очищує чернетку та стан копіювання після успішного збереження.
 */
async function handleTrainingPlanSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const messageDivId = 'training-plan-message';
  displayStatus(messageDivId, ''); // Очищуємо статус

  // selectedUserPhone має бути телефоном ЦІЛЬОВОГО користувача на момент збереження
  if (!selectedUserPhone) {
    displayStatus(
      messageDivId,
      'Помилка: Будь ласка, оберіть користувача, для якого зберігається тренування.',
      true
    );
    return;
  }

  // --- Початок валідації та збору даних ---
  const title = form.elements['training-title'].value.trim();
  const date = form.elements['training-date'].value;
  const description =
    form.elements['training-description'].value.trim() || null;
  let validationErrors = [];
  let exercises = [];

  // ... (ВАШ ІСНУЮЧИЙ КОД ВАЛІДАЦІЇ ТА ЗБОРУ ДАНИХ ДЛЯ title, date, exercises) ...
  // Ця частина залишається без змін, оскільки вона збирає дані з полів форми.
  // Переконайтеся, що тут немає логіки, яка залежить від того, чи це копія,
  // а просто збираються поточні значення з форми.

  if (!title) {
    validationErrors.push('Не заповнено назву тренування.');
  }
  if (!date) {
    validationErrors.push('Не вказано дату тренування.');
  }

  const exerciseFieldsets = document.querySelectorAll(
    '#exercises-container .exercise'
  );
  if (exerciseFieldsets.length === 0) {
    validationErrors.push('Не додано жодної вправи до тренування.');
  }

  exerciseFieldsets.forEach((fieldset, index) => {
    const exerciseNumber = index + 1;
    let exerciseIsValid = true;

    const exerciseIdInput = fieldset.querySelector('.exercise-id-input');
    const exerciseId = exerciseIdInput?.value
      ? parseInt(exerciseIdInput.value)
      : null;

    const gifIdInput = fieldset.querySelector('.gif-id-input');
    const gifId = gifIdInput?.value;
    if (!gifId || parseInt(gifId) <= 0) {
      validationErrors.push(`Вправа №${exerciseNumber}: Не обрано GIF.`);
      exerciseIsValid = false;
    }

    const nameInput = fieldset.querySelector('.name-input');
    let name = nameInput?.value.trim(); // Використовуємо let, щоб мати змогу змінити

    const descriptionInput = fieldset.querySelector('.description-input');
    let exerciseDesc = descriptionInput?.value.trim(); // Використовуємо let

    // Якщо це створення нового плану (не редагування існуючого ID)
    // І якщо назва/опис порожні, то це помилка.
    // Для копії `currentEditingPlanId` буде null, тому ця валідація спрацює.
    if (!currentEditingPlanId) {
      // Створення нового або копія
      if (!name) {
        validationErrors.push(
          `Вправа №${exerciseNumber}: Не заповнено назву вправи.`
        );
        exerciseIsValid = false;
      }
      if (!exerciseDesc) {
        validationErrors.push(
          `Вправа №${exerciseNumber}: Не заповнено техніку виконання.`
        );
        exerciseIsValid = false;
      }
    } else {
      // Редагування існуючого
      // Якщо при редагуванні поля порожні, надсилаємо null, щоб сервер не оновлював їх,
      // а використовував дані з GIF. Якщо це не бажана поведінка, змініть.
      if (!name) name = null;
      if (!exerciseDesc) exerciseDesc = null;
    }

    const setsInput = fieldset.querySelector('.sets-input');
    const sets = setsInput ? parseInt(setsInput.value) : 0;
    if (!sets || sets <= 0) {
      validationErrors.push(
        `Вправа №${exerciseNumber}: Кількість підходів має бути більше 0.`
      );
      exerciseIsValid = false;
    }

    const repsSelects = fieldset.querySelectorAll(
      '.sets-table-container .reps-select'
    );
    const weightsSelects = fieldset.querySelectorAll(
      '.sets-table-container .weight-select'
    );
    const timeSelects = fieldset.querySelectorAll(
      '.sets-table-container .time-select'
    );
    const reps = Array.from(repsSelects).map((select) =>
      select.value === '' ? null : parseInt(select.value)
    );
    const weights = Array.from(weightsSelects).map((select) =>
      select.value === '' ? null : parseInt(select.value)
    );
    const time = Array.from(timeSelects).map((select) =>
      select.value === '' ? null : parseInt(select.value)
    );

    if (
      reps.length !== sets ||
      weights.length !== sets ||
      time.length !== sets
    ) {
      validationErrors.push(
        `Вправа №${exerciseNumber}: Невідповідність даних у таблиці підходів (кількість рядків "${reps.length}" не збігається з кількістю сетів "${sets}").`
      );
      exerciseIsValid = false;
    } else {
      if (reps.some((r) => r !== null && r <= 0)) {
        validationErrors.push(
          `Вправа №${exerciseNumber}: Кількість повторень (якщо вказано) має бути > 0.`
        );
        exerciseIsValid = false;
      }
      if (weights.some((w) => w !== null && w <= 0)) {
        validationErrors.push(
          `Вправа №${exerciseNumber}: Вага (якщо вказано) має бути > 0.`
        );
        exerciseIsValid = false;
      }
      if (time.some((t) => t !== null && t <= 0)) {
        validationErrors.push(
          `Вправа №${exerciseNumber}: Час (якщо вказано) має бути > 0.`
        );
        exerciseIsValid = false;
      }
    }

    const hasAnySetData =
      reps.some((r) => r !== null) ||
      weights.some((w) => w !== null) ||
      time.some((t) => t !== null);
    if (sets > 0 && !hasAnySetData) {
      validationErrors.push(
        `Вправа №${exerciseNumber}: Заповніть хоча б один параметр (повторення, вагу або час) для підходів, або встановіть кількість підходів на 0.`
      );
      exerciseIsValid = false;
    }

    const orderInput = fieldset.querySelector('.order-input');
    const order = orderInput ? parseInt(orderInput.value) : 0;
    if (!order || order <= 0) {
      validationErrors.push(
        `Вправа №${exerciseNumber}: Не вказано або некоректний порядковий номер вправи.`
      );
      exerciseIsValid = false;
    }

    if (exerciseIsValid) {
      const emphasis =
        fieldset.querySelector('.emphasis-input')?.checked ?? false;
      const superset =
        fieldset.querySelector('.superset-input')?.checked ?? false;
      // Збираємо дані з нових <input>
      const allWeight =
        fieldset.querySelector('.all-weight')?.value.trim() || null;
      const weightRangeFromValue =
        fieldset.querySelector('.weight-range-from')?.value.trim() || '';
      const weightRangeToValue =
        fieldset.querySelector('.weight-range-to')?.value.trim() || '';
      const weightRange =
        weightRangeFromValue && weightRangeToValue
          ? `від ${weightRangeFromValue} до ${weightRangeToValue}`
          : null;

      const totalWeight =
        fieldset.querySelector('.total-weight-input')?.checked ?? false;
      const totalReps =
        fieldset.querySelector('.total-reps-input')?.checked ?? false;
      const minutes =
        parseInt(fieldset.querySelector('.rest-time-minutes')?.value) || 0;
      const seconds =
        parseInt(fieldset.querySelector('.rest-time-seconds')?.value) || 0;
      const rest_time =
        minutes * 60 + seconds > 0 ? minutes * 60 + seconds : null;

      exercises.push({
        id: exerciseId,
        gif_id: parseInt(gifId),
        name: name, // name тепер може бути null, якщо це редагування і поле було порожнім
        description: exerciseDesc, // exerciseDesc тепер може бути null
        emphasis,
        superset,
        all_weight: allWeight,
        weight_range: weightRange,
        sets,
        reps,
        weights,
        time,
        order,
        total_weight: totalWeight,
        total_reps: totalReps,
        rest_time,
      });
    }
  });
  // --- Кінець валідації та збору даних ---

  if (validationErrors.length > 0) {
    displayStatus(
      messageDivId,
      'Будь ласка, виправте помилки:<br>' + validationErrors.join('<br>'),
      true
    );
    return;
  }

  const trainingPlan = { title, date, description, exercises };
  console.log(
    'Відправка даних тренування на сервер:',
    JSON.stringify(trainingPlan, null, 2)
  );

  const statusDiv = document.getElementById(messageDivId); // Отримуємо знову, якщо displayStatus його очистив
  if (statusDiv) {
    statusDiv.innerText = 'Збереження тренування...';
    statusDiv.style.color = '#aaa';
  }

  // Запам'ятовуємо, чи була це операція копіювання, ДО того, як currentEditingPlanId може змінитися
  const wasCopyOperation =
    isCopyModeActive && !currentEditingPlanId && workoutToCopyData;

  let requestMethod = 'POST';
  let requestUrl = `/admin/trainings/${selectedUserPhone}/training-plans`;
  let successMessage = 'Тренування успішно СТВОРЕНО! Дякую за вашу роботу =)';

  if (currentEditingPlanId) {
    // Редагування існуючого плану
    requestMethod = 'PUT';
    requestUrl = `/admin/trainings/${selectedUserPhone}/training-plans/${currentEditingPlanId}`; // <-- ВИПРАВЛЕНО: Правильний шлях
    successMessage = `Тренування ID: ${currentEditingPlanId} успішно ОНОВЛЕНО! Подякував =)`;
    console.log(
      `Режим: Оновлення існуючого плану ID: ${currentEditingPlanId}. URL: ${requestUrl}`
    );
  } else {
    // Створення нового плану (включаючи копію)
    console.log(
      `Режим: Створення нового плану для користувача ${selectedUserPhone}. URL: ${requestUrl}`
    );
    // successMessage вже встановлено для створення
  }

  try {
    const { data: responseData } = await fetchWithAuth(
      requestUrl,
      {
        // Змінив data на responseData
        method: requestMethod,
        body: JSON.stringify(trainingPlan),
      },
      messageDivId
    );

    if (statusDiv) {
      statusDiv.innerText = successMessage;
      statusDiv.style.color = 'lightgreen';
    }

    // Очищення стану копіювання, якщо це була успішна операція збереження копії
    if (wasCopyOperation) {
      // Перевіряємо збережений стан
      console.log(
        '[handleTrainingPlanSubmit] Успішно збережено скопійоване тренування. Скидання стану копіювання.'
      );
      workoutToCopyData = null;
      isCopyModeActive = false;
    }

    clearWorkoutDraft(); // Очищуємо чернетку для поточного контексту
    currentEditingPlanId = null; // Завжди скидаємо ID після успішного збереження,
    // оскільки форма переходить у стан "готово до нового" або закривається.

    setTimeout(async () => {
      const formView = document.getElementById(adminWorkoutFormViewId);
      const listView = document.getElementById(adminWorkoutListViewId);
      if (formView) formView.style.display = 'none';
      if (listView) listView.style.display = 'block';

      try {
        if (selectedUserPhone) {
          await loadAdminWorkoutList(selectedUserPhone);
        }
      } catch (listError) {
        console.error(
          'Не вдалося оновити список тренувань після збереження:',
          listError
        );
        displayStatus(
          messageDivId,
          'Помилка оновлення списку тренувань',
          true,
          3000
        );
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (statusDiv && statusDiv.innerText === successMessage) {
        statusDiv.innerText = '';
        statusDiv.style.color = 'white';
      }
    }, 2000);
  } catch (error) {
    console.error('Помилка збереження тренування:', error);
    if (statusDiv) {
      displayStatus(messageDivId, `Помилка збереження: ${error.message}`, true);
    }
    // Не скидаємо isCopyModeActive та workoutToCopyData при помилці,
    // щоб користувач міг спробувати зберегти знову.
  }
}

// Функція копіювання тренування
async function handleInitiateCopyWorkout(planId, sourceUserPhone) {
  const statusDivId = adminWorkoutListStatusId; // Використовуємо статус зі списку
  displayStatus(
    statusDivId,
    `Підготовка до копіювання тренування ID: ${planId}...`
  );
  console.log(
    `[CopyInit] Користувач-джерело: ${sourceUserPhone}, План ID: ${planId}`
  );

  try {
    const { data: planDetails } = await fetchWithAuth(
      `/admin/trainings/training-plans/${planId}` // <-- ВИПРАВЛЕНО: Правильний шлях
    ); // Отримуємо повні дані плану
    if (planDetails) {
      workoutToCopyData = { ...planDetails }; // Створюємо копію об'єкта

      // ВАЖЛИВО: Видаляємо ID, оскільки це буде новий запис
      delete workoutToCopyData.id;
      // Також можна скинути поля, специфічні для виконання (якщо вони є на цьому рівні)
      if (workoutToCopyData.hasOwnProperty('completed')) {
        delete workoutToCopyData.completed;
      }
      if (workoutToCopyData.hasOwnProperty('feedback')) {
        delete workoutToCopyData.feedback;
      }
      // Дату можна або скинути, щоб адмін обрав нову
      workoutToCopyData.date = '';

      isCopyModeActive = true;
      currentEditingPlanId = null; // Дуже важливо: ми створюємо НОВЕ тренування

      // Повідомлення для адміністратора
      const message = `Тренування "${planDetails.title}" готове до копіювання.\n1. Перейдіть на вкладку "Профілі".\n2. Оберіть користувача, для якого хочете створити копію.\n3. Поверніться на вкладку "Тренування" та натисніть кнопку "+ Додати тренування".\nФорма буде заповнена даними для копіювання.`;

      // Використовуємо кастомний діалог, якщо є, або стандартний alert
      if (typeof showCustomAlertDialog === 'function') {
        // Припустимо, у вас є така функція
        showCustomAlertDialog(
          'Копіювання тренування',
          message.replace(/\n/g, '<br>')
        );
      } else {
        alert(message);
      }
      displayStatus(
        statusDivId,
        `Тренування "${planDetails.title}" готове до копіювання. Оберіть цільового користувача.`,
        false,
        10000
      );
    } else {
      throw new Error(
        'Не вдалося завантажити деталі тренування для копіювання.'
      );
    }
  } catch (error) {
    console.error('Помилка при ініціалізації копіювання тренування:', error);
    displayStatus(statusDivId, `Помилка копіювання: ${error.message}`, true);
    workoutToCopyData = null; // Скидаємо дані, якщо сталася помилка
    isCopyModeActive = false;
  }
}

/**
 * NEW: Функція для видалення вправи з тренувального плану (з деталей перегляду).
 * @param {number} planId - ID тренувального плану.
 * @param {number} exerciseId - ID вправи для видалення.
 * @param {string} userPhone - Телефон користувача (для оновлення деталей).
 */
async function deleteExerciseFromPlan(planId, exerciseId, userPhone) {
  const statusDivId = adminWorkoutDetailsStatusId; // Використовуємо статус з деталей
  displayStatus(statusDivId, `Видалення вправи ID: ${exerciseId}...`);

  try {
    const { data: response } = await fetchWithAuth(
      `/admin/trainings/training-plans/${planId}/exercises/${exerciseId}`, // <-- ВИПРАВЛЕНО: Правильний шлях
      {
        method: 'DELETE',
      },
      statusDivId
    );

    displayStatus(
      statusDivId,
      response.message || `Вправа ID: ${exerciseId} видалена. Оновлення...`,
      false,
      3000
    );
    // Оновлюємо деталі тренування, щоб побачити зміни
    await showAdminWorkoutDetails(planId, userPhone);
  } catch (error) {
    console.error(
      `Помилка видалення вправи ID ${exerciseId} з плану ID ${planId}:`,
      error
    );
    displayStatus(
      statusDivId,
      `Помилка видалення вправи: ${error.message}`,
      true,
      5000
    );
  }
}

// ========== ФУНКЦІЇ РОБОТИ З ЧЕРНЕТКАМИ ТРЕНУВАНЬ ==========

/**
 * Повертає ключ для localStorage на основі поточного контексту.
 * @returns {string|null} Ключ або null, якщо контекст не визначено.
 */
function getWorkoutDraftKey() {
  if (currentEditingPlanId) {
    return `workout_draft_edit_${currentEditingPlanId}`;
  }
  if (selectedUserPhone) {
    return `workout_draft_new_for_${selectedUserPhone}`;
  }
  // Можна додати ключ для "загальної нової чернетки", якщо потрібно
  // return 'workout_draft_generic_new';
  return null; // Якщо ні користувач, ні план для редагування не обрані
}

/**
 * Збирає дані з форми тренування для збереження в чернетку.
 * @returns {object|null} Об'єкт з даними тренування або null, якщо форма не валідна для чернетки.
 */
function collectWorkoutFormDataForDraft() {
  const form = document.getElementById('add-training-plan-form');
  if (!form) return null;

  const title = form.elements['training-title'].value.trim();
  const date = form.elements['training-date'].value;
  const description = form.elements['training-description'].value.trim(); // Не null, а порожній рядок, якщо так

  const exercises = [];
  const exerciseFieldsets = document.querySelectorAll(
    '#exercises-container .exercise'
  );

  exerciseFieldsets.forEach((fieldset) => {
    const gifIdInput = fieldset.querySelector('.gif-id-input');
    const gifId = gifIdInput?.value ? parseInt(gifIdInput.value) : null;

    const nameInput = fieldset.querySelector('.name-input');
    const name = nameInput?.value.trim();

    const descriptionInput = fieldset.querySelector('.description-input');
    const exerciseDesc = descriptionInput?.value.trim();

    const originalFilenameInput = fieldset.querySelector(
      '.original-gif-filename-input'
    ); // <--- NEW
    const originalGifFilename = originalFilenameInput?.value; // <--- NEW

    // DEBUG: Логуємо значення, яке зчитуємо з прихованого поля для збереження в чернетку
    console.log(
      `CollectDraft - Для GIF ID ${gifId}: originalGifFilename з поля = "${originalGifFilename}"`
    );

    const setsInput = fieldset.querySelector('.sets-input');
    const sets = setsInput ? parseInt(setsInput.value) : 0;

    const repsSelects = fieldset.querySelectorAll(
      '.sets-table-container .reps-select'
    );
    const weightsSelects = fieldset.querySelectorAll(
      '.sets-table-container .weight-select'
    );
    const timeSelects = fieldset.querySelectorAll(
      '.sets-table-container .time-select'
    );

    const reps = Array.from(repsSelects).map((select) =>
      select.value === '' ? null : parseInt(select.value)
    );
    const weights = Array.from(weightsSelects).map((select) =>
      select.value === '' ? null : parseInt(select.value)
    );
    const time = Array.from(timeSelects).map((select) =>
      select.value === '' ? null : parseInt(select.value)
    );

    const orderInput = fieldset.querySelector('.order-input');
    const order = orderInput
      ? parseInt(orderInput.value)
      : exercises.length + 1; // Порядковий номер

    const emphasis =
      fieldset.querySelector('.emphasis-input')?.checked ?? false;
    const superset =
      fieldset.querySelector('.superset-input')?.checked ?? false;
    // Збираємо дані з нових <input>
    const allWeight =
      fieldset.querySelector('.all-weight')?.value.trim() || null;
    const weightRangeFromValue =
      fieldset.querySelector('.weight-range-from')?.value.trim() || '';
    const weightRangeToValue =
      fieldset.querySelector('.weight-range-to')?.value.trim() || '';
    const weightRange =
      weightRangeFromValue && weightRangeToValue
        ? `від ${weightRangeFromValue} до ${weightRangeToValue}`
        : null;

    const totalWeight =
      fieldset.querySelector('.total-weight-input')?.checked ?? false;
    const totalReps =
      fieldset.querySelector('.total-reps-input')?.checked ?? false;
    const minutes =
      parseInt(fieldset.querySelector('.rest-time-minutes')?.value) || 0;
    const seconds =
      parseInt(fieldset.querySelector('.rest-time-seconds')?.value) || 0;
    const rest_time =
      minutes * 60 + seconds > 0 ? minutes * 60 + seconds : null;

    const gifData = {};
    if (gifId && originalGifFilename) {
      // <--- NEW: Використовуємо originalGifFilename
      gifData.id = gifId;
      gifData.filename = originalGifFilename; // Зберігаємо коректний відносний шлях
      gifData.name = name; // Назва вправи/GIF з поля вводу
      gifData.description = exerciseDesc; // Опис вправи/GIF з поля вводу
    }

    exercises.push({
      gif_id: gifId,
      name: name || null,
      description: exerciseDesc || null,
      emphasis,
      superset,
      all_weight: allWeight,
      weight_range: weightRange,
      sets,
      reps,
      weights,
      time,
      order,
      total_weight: totalWeight,
      total_reps: totalReps,
      rest_time,
      gif: gifData.id ? gifData : null, // Зберігаємо об'єкт gif, якщо він є
    });
  });

  return { title, date, description, exercises };
}

/**
 * Зберігає поточний стан форми тренування в localStorage.
 * Використовує debounce для уникнення занадто частих записів.
 */
function saveWorkoutDraft() {
  clearTimeout(saveDraftTimeout); // Скасувати попередній таймаут, якщо є
  saveDraftTimeout = setTimeout(() => {
    const draftKey = getWorkoutDraftKey();
    if (!draftKey) {
      console.warn('Ключ для чернетки не визначено, збереження скасовано.');
      return;
    }

    const draftData = collectWorkoutFormDataForDraft();
    if (draftData) {
      try {
        localStorage.setItem(draftKey, JSON.stringify(draftData));
        console.log(
          `Чернетка тренування збережена для ключа: ${draftKey}`,
          draftData
        );
        displayStatus(
          'training-plan-message',
          'Чернетку збережено.',
          false,
          2000
        );
      } catch (e) {
        console.error('Помилка збереження чернетки в localStorage:', e);
        displayStatus(
          'training-plan-message',
          'Помилка збереження чернетки.',
          true,
          3000
        );
      }
    }
  }, DRAFT_SAVE_DEBOUNCE_TIME);
}

/**
 * Завантажує та застосовує чернетку тренування, якщо вона існує.
 */
async function loadAndApplyWorkoutDraft() {
  const draftKey = getWorkoutDraftKey();
  if (!draftKey) {
    console.log(
      '[Draft] Ключ для чернетки не визначено, завантаження скасовано.'
    );
    return;
  }

  const savedDraftJson = localStorage.getItem(draftKey);
  if (savedDraftJson) {
    // Запит підтвердження від користувача
    if (
      confirm(
        'Знайдено збережену чернетку для цього тренування. Завантажити її? \n(Це перезапише поточні дані у формі).'
      )
    ) {
      try {
        const draftData = JSON.parse(savedDraftJson);
        console.log(
          `[Draft] Завантаження чернетки для ключа: ${draftKey}`,
          draftData
        );

        // Визначення телефону користувача, якому належить чернетка
        let userPhoneForDraft = selectedUserPhone; // За замовчуванням - поточний обраний
        // Спроба уточнити телефон на основі даних у чернетці або ключа
        if (currentEditingPlanId && draftData.phone_from_original_plan) {
          userPhoneForDraft = draftData.phone_from_original_plan;
        } else if (!currentEditingPlanId && draftData.phone_for_new_plan) {
          userPhoneForDraft = draftData.phone_for_new_plan;
        } else if (draftKey.startsWith('workout_draft_new_for_')) {
          // Якщо ключ містить телефон
          const phoneFromKey = draftKey.replace('workout_draft_new_for_', '');
          if (phoneFromKey) userPhoneForDraft = phoneFromKey;
        }
        // Якщо після всіх спроб userPhoneForDraft не визначено, а selectedUserPhone є, використовуємо його
        if (!userPhoneForDraft && selectedUserPhone) {
          userPhoneForDraft = selectedUserPhone;
        }

        if (userPhoneForDraft) {
          // ВАЖЛИВО: Якщо користувач вирішив завантажити чернетку,
          // будь-яка попередня активна операція копіювання має бути скасована,
          // оскільки чернетка тепер визначає стан форми.
          if (isCopyModeActive || workoutToCopyData) {
            console.log(
              '[Draft] Завантаження чернетки скасовує активний режим копіювання.'
            );
            workoutToCopyData = null;
            isCopyModeActive = false;
            // Також, якщо currentEditingPlanId був встановлений для копії (тобто null),
            // він може змінитися, якщо чернетка для існуючого плану.
            // Логіка currentEditingPlanId в showAddTrainingForm має це обробити.
          }

          // Викликаємо setupTrainingForm, передаючи:
          // 1. userPhoneForDraft - телефон користувача, якому належить чернетка.
          // 2. draftData - дані самої чернетки для заповнення форми.
          // 3. true (для forceIsNotCopyMode) - це вказує setupTrainingForm,
          //    що потрібно просто відновити стан з draftData,
          //    а НЕ застосовувати логіку "активного копіювання" (наприклад, запит переваг).
          await setupTrainingForm(userPhoneForDraft, draftData, true);

          displayStatus(
            'training-plan-message',
            'Чернетку успішно завантажено.',
            false,
            3000
          );
        } else {
          console.warn(
            '[Draft] Не вдалося визначити телефон користувача для завантаження чернетки.'
          );
          displayStatus(
            'training-plan-message',
            'Помилка: не вдалося визначити користувача для чернетки.',
            true,
            4000
          );
        }
      } catch (e) {
        console.error('Помилка завантаження або застосування чернетки:', e);
        displayStatus(
          'training-plan-message',
          'Помилка при завантаженні чернетки.',
          true,
          3000
        );
        // Можливо, варто видалити пошкоджену чернетку: localStorage.removeItem(draftKey);
      }
    } else {
      // Користувач відмовився завантажувати чернетку.
      // Можна запропонувати видалити її, або нічого не робити.
      // localStorage.removeItem(draftKey); // Якщо хочете видаляти при відмові
      displayStatus(
        'training-plan-message',
        'Завантаження збереженої чернетки скасовано.',
        false,
        2000
      );
    }
  } else {
    console.log('[Draft] Збережена чернетка не знайдена для ключа:', draftKey);
  }
}

/**
 * Очищує збережену чернетку тренування.
 * @param {string} [keyToClear] - Конкретний ключ для очищення (опціонально).
 */
function clearWorkoutDraft(keyToClear = null) {
  const draftKey = keyToClear || getWorkoutDraftKey();
  if (draftKey) {
    localStorage.removeItem(draftKey);
    console.log(`Чернетка тренування для ключа: ${draftKey} видалена.`);
    // Не показуємо повідомлення тут, бо це зазвичай викликається після успішного збереження
    // або якщо користувач явно натискає "Очистити"
  }
}

/**
 * NEW: Додає обробники подій до полів форми для збереження чернетки.
 */
function attachDraftSaveListeners() {
  const form = document.getElementById('add-training-plan-form');
  if (!form) return;

  // Слухачі для основних полів плану
  form.elements['training-title'].addEventListener('input', saveWorkoutDraft);
  form.elements['training-date'].addEventListener('change', saveWorkoutDraft); // 'change' для date input
  form.elements['training-description'].addEventListener(
    'input',
    saveWorkoutDraft
  );

  // Для вправ слухачі додаються динамічно в handleAddExercise та addExerciseToFormWithData
  // але можна додати делегування подій на контейнер вправ для полів, що вже існують
  const exercisesContainer = document.getElementById('exercises-container');
  if (exercisesContainer) {
    exercisesContainer.addEventListener('input', (event) => {
      // Перевіряємо, чи подія відбулася на полі вправи, яке нас цікавить
      if (
        event.target.closest('.exercise') &&
        (event.target.tagName.toLowerCase() === 'input' ||
          event.target.tagName.toLowerCase() === 'textarea' ||
          event.target.tagName.toLowerCase() === 'select')
      ) {
        saveWorkoutDraft();
      }
    });
    exercisesContainer.addEventListener('change', (event) => {
      // Для select та checkbox
      if (
        event.target.closest('.exercise') &&
        (event.target.tagName.toLowerCase() === 'select' ||
          event.target.type === 'checkbox')
      ) {
        saveWorkoutDraft();
      }
    });
  }
}

// ========== НОВИЙ БЛОК: ЛОГІКА ДЛЯ GEMINI HELPER ==========

/**
 * Керує відображенням спіннера завантаження.
 * @param {boolean} show - true, щоб показати, false - щоб сховати.
 */
function toggleGeminiLoader(show) {
  const loader = document.getElementById('gemini-loader');
  if (loader) {
    loader.style.display = show ? 'block' : 'none';
  }
}

/**
 * Заповнює форму тренування даними, отриманими від Gemini (v3 - виправлено).
 * @param {object} aiData - Об'єкт тренування, що відповідає моделі AIGeneratedWorkout.
 */
async function populateFormWithAIData(aiData) {
  console.log('[AI] Заповнення форми даними від Gemini:', aiData);
  const form = document.getElementById('add-training-plan-form');
  const exercisesContainer = document.getElementById('exercises-container');
  if (!form || !exercisesContainer) {
    console.error('[AI] Не знайдено форму або контейнер вправ для заповнення.');
    return;
  }

  // 1. Очищуємо поточні вправи з форми
  exercisesContainer.innerHTML = '';
  exerciseCounter = 0;

  // 2. Заповнюємо загальні поля
  form.elements['training-title'].value = aiData.title || '';
  form.elements['training-description'].value = aiData.description || '';
  autoResize(form.elements['training-description']);
  form.elements['training-date'].value = '';

  // 3. Додаємо вправи в циклі
  if (aiData.exercises && aiData.exercises.length > 0) {
    const userPhone = form.dataset.trainingUserPhone;
    if (!userPhone) {
      alert(
        'Критична помилка: не вдалося визначити користувача для додавання вправ.'
      );
      return;
    }

    // Завантажуємо дозволені GIF для цільового користувача ОДИН РАЗ
    const allowedGifsForTargetUser = await loadGifs(userPhone);

    // Сортуємо вправи за полем 'order' від ШІ
    const sortedExercises = aiData.exercises.sort(
      (a, b) => (a.order || 0) - (b.order || 0)
    );

    for (const exercise of sortedExercises) {
      // Шукаємо повні дані про GIF у кеші або завантаженому списку
      const fullGifData =
        gifsCache?.find((g) => g.id === exercise.gif_id) ||
        allowedGifsForTargetUser?.find((g) => g.id === exercise.gif_id);

      // Створюємо об'єкт, повністю сумісний з addExerciseToFormWithData
      const exerciseDataForForm = {
        ...exercise, // Копіюємо всі поля з відповіді ШІ (order, sets, reps, weights, based_on_preference і т.д.)
        gif: {
          // Створюємо вкладений об'єкт gif, якого очікує функція
          id: exercise.gif_id,
          name: exercise.name,
          filename: fullGifData ? fullGifData.filename : null,
          description: fullGifData
            ? fullGifData.description
            : 'Опис не знайдено',
        },
      };

      // Додаємо вправу до форми з отриманими даними
      await addExerciseToFormWithData(
        exerciseDataForForm,
        userPhone,
        false,
        allowedGifsForTargetUser
      );

      // Тепер, коли елемент створено, знаходимо його і додаємо клас для підсвітки
      if (exercise.based_on_preference === true) {
        const lastExerciseBlock = exercisesContainer.lastElementChild;
        if (lastExerciseBlock) {
          const tableContainer =
            lastExerciseBlock.querySelector('.admin-sets-table');
          if (tableContainer) {
            tableContainer.classList.add('preference-based-table');
            console.log(
              `[AI] Вправа "${exercise.name}" позначена як заснована на перевагах. Додано клас.`
            );
          }
        }
      }
    }
  }

  // 4. Зберігаємо чернетку після заповнення
  console.log('[AI] Форму заповнено. Збереження чернетки...');
  saveWorkoutDraft();
  alert(
    'Тренування від Gemini успішно згенеровано та заповнено у формі! Перевірте та збережіть його.'
  );
}

/**
 * Обробляє запит на генерацію тренування через Gemini.
 */
async function handleGeminiGeneration() {
  const promptInput = document.getElementById('gemini-prompt-input');
  const statusDiv = document.getElementById('gemini-status');
  const inputSection = document.getElementById('gemini-input-section');
  const form = document.getElementById('add-training-plan-form');

  const promptText = promptInput.value.trim();
  const userPhone = form.dataset.trainingUserPhone;

  if (!promptText) {
    displayStatus(
      'gemini-status',
      'Будь ласка, введіть опис тренування.',
      true,
      3000
    );
    return;
  }
  if (!userPhone) {
    displayStatus(
      'gemini-status',
      'Помилка: не обрано користувача.',
      true,
      3000
    );
    return;
  }

  // Ховаємо секцію вводу та показуємо спіннер
  if (inputSection) inputSection.style.display = 'none';
  toggleGeminiLoader(true);
  displayStatus(
    'gemini-status',
    'Генерація тренування... Це може зайняти до хвилини.',
    false
  );

  const requestBody = {
    muscle_group: promptText,
    user_phone: userPhone,
  };

  try {
    const { data: generatedWorkout } = await fetchWithAuth(
      '/admin/trainings/ai/generate-workout', // <-- ВИПРАВЛЕНО: Правильний шлях
      {
        method: 'POST',
        body: JSON.stringify(requestBody),
      },
      'gemini-status' // Використовуємо наш статус-дів для повідомлень
    );

    // Заповнюємо форму отриманими даними
    await populateFormWithAIData(generatedWorkout);
  } catch (error) {
    console.error('Помилка генерації тренування через Gemini:', error);
    // fetchWithAuth вже покаже помилку в 'gemini-status'
  } finally {
    // Ховаємо спіннер та очищуємо статус
    toggleGeminiLoader(false);
    displayStatus('gemini-status', '', false);
  }
} // ========== КІНЕЦЬ БЛОКУ: ЛОГІКА ДЛЯ GEMINI HELPER ==========

// ==========================================================
// === НОВИЙ БЛОК: ЛОГІКА ДЛЯ ВКЛАДКИ "ПЛАНИ" (АДМІНКА) ===
// ==========================================================

/**
 * [Admin] Завантажує згенеровані плани для обраного користувача і запускає їх відображення.
 * @param {string} userPhone - Телефон користувача.
 */
async function adminLoadAndDisplayWorkoutPlans(userPhone) {
  const container = document.getElementById('plans');
  if (!container) {
    console.error('Контейнер для планів #plans не знайдено!');
    return;
  }

  container.innerHTML = '<p>Завантаження планів тренувань користувача...</p>';

  try {
    const { data: plans } = await fetchWithAuth(
      `/admin/trainings/${userPhone}/generated-plans`
    );

    if (!plans) {
      throw new Error('Відповідь від сервера не містить даних.');
    }

    // Передаємо плани та ТЕЛЕФОН КОРИСТУВАЧА у функцію відображення
    adminRenderWorkoutPlans(plans, userPhone);
  } catch (error) {
    console.error(
      'Помилка завантаження тренувальних планів для адміна:',
      error
    );
    container.innerHTML = `<p style="color:red;">Не вдалося завантажити плани: ${error.message}</p>`;
  }
}

/**
 * [Admin] Відображає плани у вигляді під-вкладок з табличним розкладом.
 * Версія для адмін-панелі, без кнопок дій.
 * @param {Array} plans - Масив об'єктів планів з API.
 * @param {string} userPhone - Телефон користувача для пошуку імені.
 */
function adminRenderWorkoutPlans(plans, userPhone) {
  const container = document.getElementById('plans');
  if (!container) return;

  // --- ВИПРАВЛЕННЯ 1: Отримуємо ім'я користувача з кешу ---
  let selectedUserName = 'обраного користувача'; // Текст за замовчуванням
  if (userPhone && usersCache) {
    const user = usersCache.find((u) => u.phone === userPhone);
    if (user) {
      selectedUserName = user.full_name || user.phone; // Використовуємо ім'я, або телефон, якщо імені немає
    }
  }
  container.innerHTML = `<h3>Плани тренувань для: ${selectedUserName}</h3>`;
  // --- КІНЕЦЬ ВИПРАВЛЕННЯ 1 ---

  if (!plans || plans.length === 0) {
    container.innerHTML += `<div class="profile-section"><p class="empty-section-message">Для цього користувача ще не згенеровано жодного тренувального плану.</p></div>`;
    return;
  }

  let subTabsHtml = '<div class="sub-tabs plan-sub-tabs">';
  let subContentsHtml = '';

  const today = new Date();
  const activePlan =
    plans.find(
      (p) => new Date(p.start_date) <= today && new Date(p.end_date) >= today
    ) || plans[0];
  const activePlanId = activePlan.id;

  plans.forEach((plan, index) => {
    const isActive = plan.id === activePlanId;
    const startDate = new Date(plan.start_date).toLocaleDateString('uk-UA', {
      day: '2-digit',
      month: '2-digit',
    });
    const endDate = new Date(plan.end_date).toLocaleDateString('uk-UA', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    const tabButtonText = `План ${plans.length - index}: ${startDate} - ${endDate}`;

    subTabsHtml += `<button class="sub-tab-link ${isActive ? 'active' : ''}" onclick="adminOpenPlanSubTab(event, 'plan-content-admin-${plan.id}')" data-plan-id="${plan.id}">${tabButtonText}</button>`;

    subContentsHtml += `
            <div id="plan-content-admin-${plan.id}" class="plan-sub-content" style="display: ${isActive ? 'block' : 'none'};">
                <h4 class="profile-sub-content-title">${plan.plan_title || 'Тренувальний план'}</h4>

                <div class="plan-intro-text"><p>${formatTextWithLineBreaks(plan.introductory_text) || 'Загальний опис відсутній.'}</p></div>

                ${
                  plan.workouts && plan.workouts.length > 0
                    ? `
                    <div class="plan-schedule">
                        <h5 class="profile-section-title">Розклад тренувань</h5>
                        <div class="table-scroll-wrapper">
                            <table class="plan-schedule-table">
                                <thead>
                                    <tr>
                                        <th>№</th>
                                        <th>Назва тренування</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${plan.workouts
                                      .map((workout, workoutIndex) => {
                                        const typeClass = getWorkoutTypeClass(
                                          workout.title
                                        );
                                        return `
                                            <tr>
                                                <td>${workoutIndex + 1}</td>
                                                <td><span class="workout-title-badge ${typeClass}">${workout.title || 'Без назви'}</span></td>
                                            </tr>
                                        `;
                                      })
                                      .join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                `
                    : ''
                }

                <div class="plan-conclusion-text">
                    <h5 class="profile-section-title">Прогноз та рекомендації</h5>
                    <p>${formatTextWithLineBreaks(plan.concluding_text) || 'Мотивуючі поради відсутні.'}</p>
                </div>
            </div>
        `;
  });

  subTabsHtml += '</div>';
  container.innerHTML += subTabsHtml + subContentsHtml;
}

/**
 * [Admin] Перемикає видимість під-вкладок у розділі "Плани" в адмін-панелі.
 * @param {Event} event - Подія кліку.
 * @param {string} subTabContentId - ID контенту, який треба показати.
 */
function adminOpenPlanSubTab(event, subTabContentId) {
  const planContainer = document.getElementById('plans');
  if (!planContainer) return;

  // Ховаємо всі контентні блоки планів
  planContainer.querySelectorAll('.plan-sub-content').forEach((content) => {
    content.style.display = 'none';
  });

  // Знімаємо клас 'active' з усіх кнопок-вкладок планів
  planContainer
    .querySelectorAll('.plan-sub-tabs .sub-tab-link')
    .forEach((link) => {
      link.classList.remove('active');
    });

  // Показуємо потрібний контент та робимо активною кнопку
  const activeContent = document.getElementById(subTabContentId);
  if (activeContent) {
    activeContent.style.display = 'block';
  }
  if (event && event.currentTarget) {
    event.currentTarget.classList.add('active');
  }
}

/**
 * Аналізує назву тренування і повертає відповідний CSS-клас для стилізації.
 * (Цю функцію можна просто скопіювати, вона не змінилася)
 * @param {string} title - Повна назва тренування.
 * @returns {string} - Назва CSS-класу (напр., 'type-split').
 */
function getWorkoutTypeClass(title) {
  if (!title) return 'type-default';
  const lowerTitle = title.toLowerCase();

  if (lowerTitle.startsWith('спліт')) return 'type-split';
  if (lowerTitle.startsWith('фулбоді')) return 'type-fullbody';
  if (lowerTitle.startsWith('кругове')) return 'type-circuit';
  if (lowerTitle.startsWith('кардіо')) return 'type-cardio';

  return 'type-default'; // Клас за замовчуванням
}
// ========== КІНЕЦЬ функцій вкладки "Плани" ==========

// ==========================================================
// === НОВИЙ БЛОК: ЛОГІКА ДЛЯ ВКЛАДКИ "АНАЛІТИКА" ===
// ==========================================================

/**
 * [Admin] Завантажує та відображає комплексну статистику.
 */
async function loadAndDisplayAdminStats() {
  const container = document.getElementById('analytics');
  if (!container) {
    console.error('Контейнер для аналітики #analytics не знайдено!');
    return;
  }

  container.innerHTML = '<h3>Завантаження статистики...</h3>';

  let requestUrl = '/admin/statistics/list';

  // Перевіряємо, чи обраний користувач є тренером, і якщо так - додаємо його до запиту
  if (selectedUserPhone && usersCache) {
    const selectedUser = usersCache.find((u) => u.phone === selectedUserPhone);
    if (selectedUser && selectedUser.is_trainer) {
      requestUrl += `?trainer_phone=${selectedUserPhone}`;
    }
  }

  try {
    const { data: stats } = await fetchWithAuth(requestUrl);
    renderAdminStats(stats);
  } catch (error) {
    console.error('Помилка завантаження статистики:', error);
    container.innerHTML = `<h3 style="color:red;">Не вдалося завантажити статистику: ${error.message}</h3>`;
  }
}

/**
 * [Admin] Генерує HTML-код та відображає статистику в контейнері.
 * @param {object} stats - Об'єкт зі статистикою, отриманий з API.
 */
function renderAdminStats(stats) {
  const container = document.getElementById('analytics');
  if (!container) return;

  // Допоміжна функція для створення рядка таблиці
  const createRow = (label, value, options = {}) => {
    const { isSubItem = false, valueClass = '' } = options;
    return `
            <tr class="${isSubItem ? 'sub-item' : ''}">
                <td>${label}</td>
                <td><span class="stats-value ${valueClass}">${value}</span></td>
            </tr>
        `;
  };

  let html = '<h3>Аналітика платформи Lily & Max sport 🚀</h3>';

  // Визначаємо, чи це статистика по тренеру, перевіряючи глобальний стан
  let headerText = 'Загальні показники платформи';
  if (selectedUserPhone && usersCache) {
    const selectedUser = usersCache.find((u) => u.phone === selectedUserPhone);
    if (selectedUser && selectedUser.is_trainer) {
      headerText = `Показники тренера: ${selectedUser.full_name || selectedUser.phone}`;
    }
  }

  // Блок 1: Загальна кількість (з динамічним заголовком)
  html += `
        <h4 class="stats-header">${headerText}</h4>
        <table class="stats-table">
            <tbody>
                ${createRow('Всього зареєстровано користувачів', stats.total_registered_users, { valueClass: 'stats-value-total' })}
            </tbody>
        </table>
    `;

  // Блок 2: Активні підписки
  html += `
        <h4 class="stats-header">Активні підписки</h4>
        <table class="stats-table">
            <tbody>
                ${createRow('Всього з активною підпискою', stats.active_subscriptions.total, { valueClass: 'stats-value-total' })}
                
                ${createRow('Всього з автооновленням підписки', stats.active_subscriptions.with_auto_renew_enabled, { valueClass: 'stats-value-purple' })}
                
                ${createRow('Користувачі "з тренером"', stats.active_subscriptions.breakdown.with_trainer, { isSubItem: true })}
                ${createRow('Користувачі "з тренером" (самостійні)', stats.active_subscriptions.breakdown.with_trainer_independent, { isSubItem: true })}
                ${createRow('Користувачі "без тренера"', stats.active_subscriptions.breakdown.without_trainer, { isSubItem: true })}
            </tbody>
        </table>
    `;

  // Блок 3: Неактивні підписки
  html += `
        <h4 class="stats-header">Неактивні/завершені підписки</h4>
        <table class="stats-table">
            <tbody>
                ${createRow('Всього з неактивною підпискою', stats.inactive_subscriptions.total, { valueClass: 'stats-value-red' })}
                ${createRow('Користувачі "з тренером"', stats.inactive_subscriptions.breakdown.with_trainer, { isSubItem: true, valueClass: 'stats-value-orange' })}
                ${createRow('Користувачі "з тренером" (самостійні)', stats.inactive_subscriptions.breakdown.with_trainer_independent, { isSubItem: true, valueClass: 'stats-value-orange' })}
                ${createRow('Користувачі "без тренера"', stats.inactive_subscriptions.breakdown.without_trainer, { isSubItem: true, valueClass: 'stats-value-orange' })}
            </tbody>
        </table>
    `;

  // Блок 4: Середня тривалість підписки
  html += `
        <h4 class="stats-header">Середня тривалість підписки (утримання клієнтів)</h4>
        <table class="stats-table">
            <tbody>
                ${createRow('Для всіх користувачів', `${stats.average_subscription_duration.all_users_days.toFixed(1)} днів`, { valueClass: 'stats-value-total' })}
                ${createRow('"з тренером"', `${stats.average_subscription_duration.with_trainer_days.toFixed(1)} днів`, { isSubItem: true })}
                ${createRow('"з тренером" (самостійні)', `${stats.average_subscription_duration.with_trainer_independent_days.toFixed(1)} днів`, { isSubItem: true })}
                ${createRow('"без тренера"', `${stats.average_subscription_duration.without_trainer_days.toFixed(1)} днів`, { isSubItem: true })}
            </tbody>
        </table>
    `;

  // Блок 5: Статистика дій
  html += `
        <h4 class="stats-header">Активність користувачів (за останні 2 дні)</h4>
        <table class="stats-table">
            <tbody>
                ${createRow('Використання Gemini для аналізу фідбеку', stats.feature_usage_last_2_days.feedback_analysis_users_last_2d, { valueClass: 'stats-value-red' })}
                ${createRow('Використання Gemini для створення самостійного тренування', stats.feature_usage_last_2_days.self_generation_users_last_2d, { valueClass: 'stats-value-red' })}
            </tbody>
        </table>
    `;

  // Блок 6: Статистика генерацій Gemini
  html += `
        <h4 class="stats-header">Автоматичні генерації Gemini (за останні 24 години)</h4>
        <table class="stats-table">
            <tbody>
                ${createRow('Згенеровано Планів тренувань', stats.generation_activity_last_24h.plans_generated_last_24h, { valueClass: 'stats-value-orange' })}
                ${createRow('Згенеровано пакетів тренувань на тиждень', stats.generation_activity_last_24h.weekly_batches_generated_last_24h, { valueClass: 'stats-value-orange' })}
            </tbody>
        </table>
    `;

  html += `<p style="font-size: 0.8em; color: #888; margin-top: 10px;">*Примітка: Статистика по тренеру відображається, якщо у вкладці "Профілі" обрати користувача з роллю "Тренер".</p>`;

  container.innerHTML = html;
}
// ========== КІНЕЦЬ функцій вкладки "АНАЛІТИКА" ==========

// ==========================================================
// === НОВИЙ БЛОК: ЛОГІКА ДЛЯ ВКЛАДКИ "ДІЇ" ===
// ==========================================================

/**
 * [Admin] Обробляє натискання кнопок для запуску планувальників.
 * @param {string} taskType - Тип завдання ('weekly', 'monthly', 'renewal').
 */
async function handleSchedulerTrigger(taskType) {
  const taskDetails = {
    weekly: {
      confirmText:
        'Ви впевнені, що хочете запустити генератор тижневих тренувань?',
      body: { trigger_weekly_workouts: true },
      statusId: 'scheduler-status-weekly',
      buttonSelector: `button[data-task="weekly"]`,
    },
    monthly: {
      confirmText:
        'Ви впевнені, що хочете запустити генератор 30-денних планів?',
      body: { trigger_monthly_plan_generation: true },
      statusId: 'scheduler-status-monthly',
      buttonSelector: `button[data-task="monthly"]`,
    },
    renewal: {
      confirmText: 'Ви впевнені, що хочете запустити автопоновлення підписок?',
      body: { trigger_auto_renewals: true },
      statusId: 'scheduler-status-renewal',
      buttonSelector: `button[data-task="renewal"]`,
    },
  };

  const details = taskDetails[taskType];
  if (!details) {
    console.error('Невідомий тип завдання для планувальника:', taskType);
    return;
  }

  if (!confirm(details.confirmText)) {
    return;
  }

  const button = document.querySelector(details.buttonSelector);
  const originalButtonText = button.textContent;
  const statusDiv = document.getElementById(details.statusId);

  button.disabled = true;
  button.textContent = 'Виконується...';
  if (statusDiv) statusDiv.innerHTML = '';
  displayStatus(details.statusId, 'Відправка запиту...', false, 10000); // Повідомлення зникне, якщо не буде логів

  try {
    const { data } = await fetchWithAuth(
      '/admin/debug/trigger-scheduler',
      {
        method: 'POST',
        body: JSON.stringify(details.body),
      },
      details.statusId
    );

    // ===== ОНОВЛЕНА ЛОГІКА: ВІДКРИВАЄМО МОДАЛЬНЕ ВІКНО =====
    if (data.logs && Array.isArray(data.logs) && data.logs.length > 0) {
      const logModalOverlay = document.getElementById('log-modal-overlay');
      const logModalMessage = document.getElementById('log-modal-message');
      const logModalContent = document.getElementById('log-modal-content');

      const logText = data.logs.join('\n');

      logModalMessage.textContent = data.message;
      logModalContent.textContent = logText; // Використовуємо .textContent для безпеки
      logModalOverlay.style.display = 'flex';

      // Очищуємо тимчасовий статус, оскільки показали модальне вікно
      displayStatus(details.statusId, '', false);
    } else {
      // Якщо логів немає, показуємо звичайне повідомлення, яке зникне
      displayStatus(details.statusId, data.message, false, 10000);
    }
  } catch (error) {
    console.error(`Помилка запуску планувальника '${taskType}':`, error);
    // displayStatus вже покаже помилку, яка зникне через 15 сек
    displayStatus(details.statusId, `Помилка: ${error.message}`, true, 15000);
  } finally {
    button.disabled = false;
    button.textContent = originalButtonText;
  }
} // ========== КІНЕЦЬ вкладки "ДІЇ" ==========

// ========== ПРИВ'ЯЗКА ОБРОБНИКІВ ПОДІЙ ==========

// Прив'язуємо обробник ТІЛЬКИ для форми логіну одразу
const loginFormElement = document.getElementById('login-form'); // Використовуємо інше ім'я змінної
if (loginFormElement) {
  loginFormElement.addEventListener('submit', handleAdminLogin);
  console.log("[Init] Обробник 'submit' для #login-form прив'язано.");
} else {
  console.error('[Init] НЕ ЗНАЙДЕНО ФОРМУ ЛОГІНУ #login-form!');
}

/**
 * Прив'язує обробники подій до елементів адмін-панелі.
 * Викликається один раз після успішного логіну.
 */
function attachAdminPanelListeners() {
  console.log("[Init] Прив'язка обробників подій адмін-панелі...");

  // Форма реєстрації
  const registerForm = document.getElementById('register-form');
  if (registerForm)
    registerForm.addEventListener('submit', handleRegisterSubmit);
  else console.error('[Init] Елемент #register-form не знайдено!');

  // Кнопки вкладок
  const tabButtons = document.querySelectorAll('#admin-panel .tab-link');
  tabButtons.forEach((button) => {
    button.addEventListener('click', (event) => {
      const onclickAttr = button.getAttribute('onclick');
      const match = onclickAttr ? onclickAttr.match(/'([^']+)'/) : null;
      if (match && match[1]) openTab(event, match[1]);
      else console.error('Не вдалося отримати назву вкладки', button);
    });
  });
  if (tabButtons.length === 0)
    console.error('[Init] Кнопки вкладок не знайдено!');

  // Кнопка виходу
  const logoutButton = document.getElementById('confirm-logout');
  if (logoutButton) logoutButton.addEventListener('click', handleLogout);
  else console.error('[Init] Елемент #confirm-logout не знайдено!');

  // Поле пошуку користувачів
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (usersCache && currentAdminTab === 'profiles')
        displayUserList(usersCache);
    });
  } else console.warn('[Init] Елемент #search-input не знайдено!');

  // 👇 БЛОК Активувати/Скасувати підписку 👇
  const profileDetailsContainer = document.getElementById('profile-details');
  if (profileDetailsContainer) {
    profileDetailsContainer.addEventListener('click', (event) => {
      // --- ПОЧАТОК ЗМІН ---
      // Використовуємо .closest(), щоб гарантовано знайти кнопку,
      // навіть якщо клік був по тексту всередині неї.
      const button = event.target.closest('.subscription-actions button');

      // Делегування для кнопок "Скасувати/Активувати" підписку
      if (button) {
        if (selectedUserPhone) {
          // Передаємо в обробник сам елемент кнопки, а не всю подію.
          // Це робить функцію handleUpdateSubscriptionStatus більш надійною.
          handleUpdateSubscriptionStatus(button, selectedUserPhone);
        }
      }
      // --- КІНЕЦЬ ЗМІН ---
    });

    // Делегування для форми додавання підписки
    profileDetailsContainer.addEventListener('submit', (event) => {
      if (event.target.id === 'add-subscription-form') {
        if (selectedUserPhone) {
          handleAddSubscription(event, selectedUserPhone);
        }
      }
    });
  }
  // --- Кінець блоку кнопки Актувати/Скасувати підписку ---

  // --- Обробники для вкладки "Тренування" ---
  const addExerciseBtn = document.getElementById('add-exercise-btn');
  if (addExerciseBtn) {
    addExerciseBtn.addEventListener('click', async () => {
      // Зробили async
      const formElement = document.getElementById('add-training-plan-form');
      // Отримуємо телефон користувача, для якого зараз відкрита/редагується форма тренування
      const currentUserPhoneForWorkout = formElement
        ? formElement.dataset.trainingUserPhone
        : null;

      if (currentUserPhoneForWorkout) {
        console.log(
          `[add-exercise-btn Click] Виклик handleAddExercise з телефоном: ${currentUserPhoneForWorkout} (з form.dataset)`
        );
        // Для нової вправи, isInCopyMode = false.
        // allowedGifsForTargetUser можна завантажити тут, якщо він потрібен handleAddExercise для чогось,
        // крім передачі в loadGifs (яка сама фільтрує).
        // Якщо handleAddExercise сама завантажує GIF для вибору (що логічно), то allowedGifs... тут не потрібен.
        // Припустимо, handleAddExercise очікує лише телефон:
        await handleAddExercise(currentUserPhoneForWorkout, false, null); // Третій параметр може бути null, якщо handleAddExercise сама впорається
      } else {
        // Якщо з якоїсь причини data-атрибут не встановлено,
        // можна спробувати використати глобальний selectedUserPhone як запасний варіант.
        // Або вивести більш конкретну помилку.
        console.warn(
          '[add-exercise-btn Click] Телефон користувача для тренування не знайдено в data-атрибуті форми. Спроба використати глобальний selectedUserPhone.'
        );
        if (selectedUserPhone) {
          // Перевіряємо, чи існує глобальний selectedUserPhone
          console.log(
            `[add-exercise-btn Click] Виклик handleAddExercise з глобальним selectedUserPhone: ${selectedUserPhone}`
          );
          handleAddExercise(selectedUserPhone); // Передаємо глобальний selectedUserPhone
        } else {
          alert(
            'Помилка: Неможливо визначити користувача для додавання вправи. Будь ласка, переконайтеся, що користувача обрано та форма тренування ініціалізована правильно.'
          );
          console.error(
            '[add-exercise-btn Click] Не вдалося визначити телефон користувача. Не знайдено ані form.dataset.trainingUserPhone, ані глобального selectedUserPhone.'
          );
        }
      }
    });
    console.log(
      "[Init] Обробник 'click' для #add-exercise-btn прив'язано (з передачею телефону)."
    );
  } else {
    console.error('[Init] Елемент #add-exercise-btn не знайдено!');
  }

  const trainingForm = document.getElementById('add-training-plan-form');
  if (trainingForm)
    trainingForm.addEventListener('submit', handleTrainingPlanSubmit);
  else console.error('[Init] Елемент #add-training-plan-form не знайдено!');

  const showAddBtn = document.getElementById('show-add-training-form-btn');
  if (showAddBtn) {
    showAddBtn.addEventListener('click', () => {
      // При натисканні цієї кнопки ми завжди хочемо або почати новий план,
      // або ініціювати логіку копіювання, якщо є дані.
      // В обох випадках ми не передаємо існуючий план для прямого редагування.
      // Тому викликаємо showAddTrainingForm з null.
      console.log(
        "Кнопка '+ Додати тренування' натиснута, виклик showAddTrainingForm(null)"
      );
      showAddTrainingForm(null);
    });
    // Додамо лог, що обробник прив'язано коректно (опціонально)
    // console.log("[Init] Обробник для #show-add-training-form-btn встановлено правильно.");
  } else {
    console.error('[Init] Елемент #show-add-training-form-btn не знайдено!');
  }

  const exercisesContainer = document.getElementById('exercises-container');
  if (exercisesContainer) {
    // Існуючий слухач для input (для saveWorkoutDraft)
    exercisesContainer.addEventListener('input', (event) => {
      if (
        event.target.closest('.exercise') &&
        (event.target.tagName.toLowerCase() === 'input' ||
          event.target.tagName.toLowerCase() === 'textarea' ||
          event.target.tagName.toLowerCase() === 'select')
      ) {
        // Не обробляємо тут sets-input, щоб уникнути подвійного saveWorkoutDraft,
        // якщо він вже викликається з обробника 'change' для sets-input
        if (!event.target.classList.contains('sets-input')) {
          saveWorkoutDraft();
        }
      }
    });

    // Існуючий слухач для change (для saveWorkoutDraft) + НОВИЙ для sets-input
    exercisesContainer.addEventListener('change', (event) => {
      const exerciseFieldset = event.target.closest('.exercise');
      if (!exerciseFieldset) return;

      if (
        event.target.classList.contains('weight-range-from') ||
        event.target.classList.contains('weight-range-to')
      ) {
        saveWorkoutDraft(); // Виклик збереження чернетки
      }

      // Логіка для збереження чернетки для select та checkbox
      if (
        event.target.tagName.toLowerCase() === 'select' ||
        event.target.type === 'checkbox'
      ) {
        // Не обробляємо тут sets-input для saveWorkoutDraft, якщо він обробляється нижче
        if (!event.target.classList.contains('sets-input')) {
          saveWorkoutDraft();
        }
      }

      // НОВА ЛОГІКА: Обробка зміни кількості сетів
      if (event.target.classList.contains('sets-input')) {
        const setsTableContainer = exerciseFieldset.querySelector(
          '.sets-table-container'
        );
        if (!setsTableContainer) {
          console.error(
            'Не знайдено setsTableContainer для інпута сетів:',
            event.target
          );
          return;
        }
        const newSets = parseInt(event.target.value) || 0;

        // 1. Зберігаємо поточні значення з існуючої таблиці
        const currentRepsSelects =
          setsTableContainer.querySelectorAll('.reps-select');
        const currentWeightsSelects =
          setsTableContainer.querySelectorAll('.weight-select');
        const currentTimeSelects =
          setsTableContainer.querySelectorAll('.time-select');

        const currentRepsValues = Array.from(currentRepsSelects).map(
          (select) => select.value
        );
        const currentWeightsValues = Array.from(currentWeightsSelects).map(
          (select) => select.value
        );
        const currentTimeValues = Array.from(currentTimeSelects).map(
          (select) => select.value
        );

        // 2. Генеруємо нову структуру таблиці
        generateSetsTable(newSets, setsTableContainer);

        // 3. Відновлюємо збережені значення в новій таблиці
        const newRepsSelects =
          setsTableContainer.querySelectorAll('.reps-select');
        const newWeightsSelects =
          setsTableContainer.querySelectorAll('.weight-select');
        const newTimeSelects =
          setsTableContainer.querySelectorAll('.time-select');

        const rowsToRestore = Math.min(newSets, currentRepsValues.length); // Або currentWeightsValues.length, currentTimesValues.length

        for (let i = 0; i < newSets; i++) {
          // Ітеруємо до newSets, щоб заповнити всі нові рядки
          if (i < rowsToRestore) {
            // Якщо є старі дані для цього рядка
            if (newRepsSelects[i] && currentRepsValues[i] !== undefined) {
              newRepsSelects[i].value = currentRepsValues[i];
            }
            if (newWeightsSelects[i] && currentWeightsValues[i] !== undefined) {
              newWeightsSelects[i].value = currentWeightsValues[i];
            }
            if (newTimeSelects[i] && currentTimeValues[i] !== undefined) {
              newTimeSelects[i].value = currentTimeValues[i];
            }
          } else {
            // Для нових рядків, яких не було, можна залишити плейсхолдери
            // newRepsSelects[i].value = ""; // або залишити як є (з плейсхолдером)
            // newWeightsSelects[i].value = "";
            // newTimeSelects[i].value = "";
          }
        }
        saveWorkoutDraft(); // Зберігаємо чернетку після зміни
      }
    });
  }

  // Кнопка очищення чернетки
  const clearDraftBtn = document.getElementById('clear-workout-draft-btn');
  if (clearDraftBtn) {
    clearDraftBtn.addEventListener('click', () => {
      const draftKey = getWorkoutDraftKey();
      if (
        draftKey &&
        confirm(
          `Ви впевнені, що хочете очистити поточну чернетку тренування? Ця дія незворотня.`
        )
      ) {
        clearWorkoutDraft(draftKey);
        if (currentEditingPlanId) {
          // Після loadWorkoutForEditing форма може бути довгою, скрол потрібен
          loadWorkoutForEditing(currentEditingPlanId, selectedUserPhone).then(
            () => {
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
          );
        } else if (selectedUserPhone) {
          // Після setupTrainingForm також може знадобитися скрол
          setupTrainingForm(selectedUserPhone).then(() => {
            // Якщо setupTrainingForm асинхронна
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });
          // Якщо setupTrainingForm синхронна:
          // setupTrainingForm(selectedUserPhone);
          // window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          window.scrollTo({ top: 0, behavior: 'smooth' }); // Загальний випадок
        }
        displayStatus(
          'training-plan-message',
          'Чернетку очищено.',
          false,
          2000
        );
      }
    });
  } else {
    console.warn('[Init] Елемент #clear-workout-draft-btn не знайдено!');
  }

  const cancelAddBtn = document.getElementById('cancel-add-training-btn');
  if (cancelAddBtn) {
    cancelAddBtn.addEventListener('click', () => {
      console.log(
        '[UI Action] Натиснуто Скасувати/Назад зі сторінки форми тренування'
      );
      const formView = document.getElementById(adminWorkoutFormViewId);
      const listView = document.getElementById(adminWorkoutListViewId);

      // --- ВИПРАВЛЕННЯ ТУТ ---
      if (formView) formView.style.display = 'none'; // Ховаємо форму
      if (listView) listView.style.display = 'block'; // Показуємо список
      // --- КІНЕЦЬ ВИПРАВЛЕННЯ ---

      // Список не перезавантажуємо, якщо просто скасували додавання
      currentEditingPlanId = null; // NEW: Скидаємо ID при скасуванні
    });
    console.log(
      "[Init] Обробник 'click' для #cancel-add-training-btn прив'язано."
    );
  } else {
    console.error('[Init] Елемент #cancel-add-training-btn не знайдено!');
  }

  const backFromDetailsBtn = document.getElementById(
    'admin-back-to-workout-list-btn'
  );
  if (backFromDetailsBtn) {
    backFromDetailsBtn.addEventListener('click', () => {
      console.log('[UI Action] Натиснуто Назад зі сторінки деталей тренування');
      const detailsView = document.getElementById(adminWorkoutDetailsViewId);
      const listView = document.getElementById(adminWorkoutListViewId);

      // --- ВИПРАВЛЕННЯ ТУТ ---
      if (detailsView) detailsView.style.display = 'none'; // Ховаємо деталі
      if (listView) listView.style.display = 'block'; // Показуємо список
      // --- КІНЕЦЬ ВИПРАВЛЕННЯ ---

      // Перезавантажуємо список для актуальності
      if (selectedUserPhone) loadAdminWorkoutList(selectedUserPhone);
    });
    console.log(
      "[Init] Обробник 'click' для #admin-back-to-workout-list-btn прив'язано."
    );
  } else {
    console.error(
      '[Init] Елемент #admin-back-to-workout-list-btn не знайдено!'
    );
  }

  // --- НОВИЙ БЛОК: Обробники для Gemini Helper ---
  const toggleGeminiBtn = document.getElementById('toggle-gemini-helper-btn');
  const geminiInputSection = document.getElementById('gemini-input-section');
  const generateBtn = document.getElementById('generate-with-gemini-btn');

  if (toggleGeminiBtn && geminiInputSection) {
    toggleGeminiBtn.addEventListener('click', () => {
      // Перемикаємо видимість секції для вводу
      const isVisible = geminiInputSection.style.display === 'block';
      geminiInputSection.style.display = isVisible ? 'none' : 'block';
    });
  } else {
    console.error('[Init] Не знайдено кнопки або секцію для Gemini Helper!');
  }

  if (generateBtn) {
    generateBtn.addEventListener('click', handleGeminiGeneration);
  } else {
    console.error("[Init] Не знайдено кнопку 'Згенерувати' для Gemini!");
  } // --- КІНЕЦЬ БЛОКУ GEMINI HELPER ---

  // --- Кінець обробників для "Тренування" ---

  // ===== ПОЧАТОК БЛОКУ ДЛЯ ВКЛАДКИ "ДІЇ" =====
  const actionsContainer = document.getElementById('actions');
  if (actionsContainer) {
    actionsContainer.addEventListener('click', (event) => {
      const button = event.target.closest('.action-btn');
      if (button && !button.disabled) {
        const taskType = button.dataset.task;
        if (taskType) {
          handleSchedulerTrigger(taskType);
        }
      }
    });
  } else {
    console.error('[Init] Контейнер #actions не знайдено!');
  }
  // ===== КІНЕЦЬ БЛОКУ "ДІЇ" =====

  // ===== ОБРОБНИКИ ДЛЯ МОДАЛЬНОГО ВІКНА ЛОГІВ =====
  const logModalOverlay = document.getElementById('log-modal-overlay');
  const logModalCloseBtn = document.getElementById('log-modal-close');

  if (logModalOverlay && logModalCloseBtn) {
    const closeModal = () => {
      logModalOverlay.style.display = 'none';
    };

    // Закриття по кнопці "ОК"
    logModalCloseBtn.addEventListener('click', closeModal);

    // Закриття по кліку на темний фон
    logModalOverlay.addEventListener('click', (event) => {
      if (event.target === logModalOverlay) {
        closeModal();
      }
    });
  }
  // ===== КІНЕЦЬ БЛОКУ МОДАЛЬНОГО ВІКНА ЛОГІВ =====

  // --- Блок "ПОВІДОМЛЕННЯ" ---
  console.log("[Init] Прив'язка обробників для вкладки 'Повідомлення'...");

  const notificationForm = document.getElementById('notification-form');
  if (notificationForm) {
    // Використовуємо делегування подій, це найнадійніше
    notificationForm.addEventListener('click', (event) => {
      // Обробник для кнопки "Опублікувати/Оновити"
      if (event.target.id === 'notification-submit-btn') {
        handleNotificationFormSubmit(event);
      }
      // Обробник для кнопки "Скасувати"
      if (event.target.id === 'notification-cancel-edit-btn') {
        resetNotificationForm();
      }
    });
  } else {
    console.error('[Init] Не знайдено форму #notification-form!');
  }
  // --- КІНЕЦЬ БЛОКУ "ПОВІДОМЛЕННЯ" ---

  // Делегування подій для авто-ресайзу textarea
  document.body.addEventListener('input', (event) => {
    if (event.target.tagName.toLowerCase() === 'textarea')
      autoResize(event.target);
  });
  // Початковий ресайз існуючих textarea (краще робити при показі панелі)
  document.querySelectorAll('#admin-panel textarea').forEach(autoResize);

  console.log("[Init] Прив'язка обробників адмін-панелі завершена.");
}

// --- Ініціалізація при завантаженні сторінки ---
document.addEventListener('DOMContentLoaded', () => {
  // Перевіряємо, чи є токени та статус адміна
  const token = getAdminAccessToken();
  const isAdmin = localStorage.getItem('is_admin') === 'true';

  if (token && isAdmin) {
    console.log(
      'Admin: Користувач авторизований як адмін при завантаженні сторінки.'
    );
    showAdminPanelContent(); // Показуємо панель
    // openTab(null, 'profiles'); // Відкриваємо вкладку за замовчуванням
    scheduleProactiveAdminTokenRefresh(); // Плануємо перше проактивне оновлення
  } else {
    console.log(
      'Admin: Користувач не авторизований як адмін при завантаженні. Показ форми логіну.'
    );
    showAdminLogin(); // Встановлюємо початковий стан UI (завжди показуємо логін)
  }
  // Прив'язка обробника до форми логіну (якщо вона ще не була прив'язана)
  const loginFormElem = document.getElementById('login-form');
  if (loginFormElem && !loginFormElem.hasAttribute('data-listener-attached')) {
    loginFormElem.addEventListener('submit', handleAdminLogin);
    loginFormElem.setAttribute('data-listener-attached', 'true');
    console.log("[Init Admin] Обробник 'submit' для #login-form прив'язано.");
  }
  const workoutListContainer = document.getElementById('admin-workout-list');
  if (workoutListContainer) {
    workoutListContainer.addEventListener('click', (event) => {
      const detailsButton = event.target.closest('.details-button'); // Замініть на ваш реальний селектор
      if (detailsButton) {
        const planId = detailsButton.dataset.planId;
        const userPhone = detailsButton.dataset.userPhone;

        // Виклик функції, яка тепер гарантовано знайде всі елементи
        showAdminWorkoutDetails(planId, userPhone);
      }
    });
  }
});
