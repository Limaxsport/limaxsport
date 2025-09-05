// --- Базові функції та Налаштування ---

const baseURL = 'https://limaxsport.top/testapi'; // Базовий URL вашого API

// === ДЕТЕКТОР ПОВІЛЬНОГО ІНТЕРНЕТ-З'ЄДНАННЯ ===
const slowConnectionDetector = {
  timerId: null,
  element: null,
  start: function (elementId, timeout = 7000) {
    // Чекаємо 7 секунд перед показом
    this.stop(); // Зупиняємо попередній таймер, якщо він був
    this.element = document.getElementById(elementId);

    this.timerId = setTimeout(() => {
      if (this.element) {
        this.element.innerHTML =
          "⏳ Схоже, у вас повільний Інтернет-зв'язок. Зачекайте, будь ласка...";
        this.element.style.color = '#ffc107'; // Жовтий колір
      }
    }, timeout);
  },
  stop: function () {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    // Очищуємо повідомлення, тільки якщо це було наше попередження
    if (this.element && this.element.innerHTML.includes('⏳')) {
      this.element.innerHTML = '';
      this.element.style.color = ''; // Повертаємо стандартний колір
    }
    this.element = null;
  },
};

// Змінні для управління процесом оновлення токенів
let isRefreshing = false;
let failedQueue = [];
let proactiveRefreshTimerId = null; // ID таймера для проактивного оновлення
let accessTokenExpiresAt = null; // Час (timestamp) коли access token закінчується

let aiAnalysisPollInterval = null; // ID для таймера, що перевіряє готовність аналізу

// Змінна для зберігання "оригінальної" версії тренування, яке переглядається
let originalPlanDataForDetails = null;

// === NEW: Змінні для пагінації тренувань користувача ===
const WORKOUTS_INITIAL_LOAD = 5; // Скільки завантажувати спочатку
const WORKOUTS_PER_PAGE_MORE = 5; // Скільки дозавантажувати по кнопці
let totalUserWorkoutsAvailable = 0; // Загальна кількість тренувань на сервері
let isLoadingMoreUserWorkouts = false; // Прапорець для уникнення подвійних запитів

// --- НОВІ ЗМІННІ ДЛЯ ФОРМИ ТРЕНУВАННЯ ---
let currentUserProfileData = null; // Кеш для даних профілю поточного користувача
let userGifsCache = {}; // Кеш для GIF-файлів, специфічний для користувача (щоб не плутати з адмінкою)
let userExerciseCounter = 0; // Лічильник вправ для форми користувача
let userWorkoutDraftTimeout = null; // Таймер для автозбереження чернетки
let currentEditingUserPlanId = null; // ID плану, який редагує користувач (для майбутнього функціоналу)

// === NEW: Змінні та константи для таймера відпочинку ===
const restTimerModal = document.getElementById('restTimerModal');
const timerDisplay = document.getElementById('timer-display');
const timerStatusText = document.getElementById('timer-status-text');
let restTimerInterval = null; // ID для setInterval, щоб його можна було зупинити
let initialTimerDuration = 0; // Зберігаємо початковий час для перезапуску

// ▼▼▼ ДОДАЙТЕ ЦІ ДВА РЯДКИ ▼▼▼
const timerSoundToggleBtn = document.getElementById('timer-sound-toggle-btn');
// За замовчуванням звуки увімкнені, якщо в пам'яті не збережено інше
let areTimerSoundsEnabled =
  localStorage.getItem('timerSoundsEnabled') !== 'false';

// === WEB AUDIO API ДЛЯ НАДІЙНОЇ РОБОТИ ЗВУКУ ===
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
let tickBuffer = null;
let finishBuffer = null;
let finish2Buffer = null;
// ВИПРАВЛЕНО: Ці прапорці тепер керують завантаженням "на льоту"
let areSoundsLoaded = false; // Змінили назву для ясності
let isAudioInitializing = false; // Щоб уникнути подвійного завантаження

// === НОВИЙ КОНТРОЛЕР ДЛЯ ПОСЛІДОВНОГО ТАЙМЕРА ===
let workTimerController = {
  isActive: false,
  stage: 'idle', // 'idle', 'preparing', 'working', 'resting'
  currentSet: 0,
  totalSets: 0,
  workTimes: [], // Масив з часом для кожного підходу
  restTime: 0, // Єдиний час відпочинку
  onComplete: null, // Функція, яка виконається в кінці
};

// Константи для проактивного оновлення
const PROACTIVE_REFRESH_LEAD_TIME_MS = 2 * 60 * 1000; // За скільки мс до закінчення токена пробувати оновити (2 хвилини)
const DEFAULT_ACCESS_TOKEN_LIFETIME_MS = 120 * 60 * 1000; // 120 хвилин, якщо expires_in не надано
const RETRY_ATTEMPTS = 3; // Кількість повторних спроб оновлення
const RETRY_INITIAL_DELAY_MS = 5000; // Початкова затримка перед повтором (5 секунд)
const RETRY_BACKOFF_FACTOR = 2; // Множник для експоненційної затримки

// Функція для обробки запитів, що очікують
const processQueue = (error, token = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

// +++ ДОДАНО: Нові функції для роботи з тимчасовою "пам'яттю" тренування +++
function getInProgressWorkoutData(planId) {
  const inProgressKey = `inProgressPlan_${planId}`;
  return JSON.parse(localStorage.getItem(inProgressKey)) || {};
}

function setInProgressWorkoutData(planId, data) {
  const inProgressKey = `inProgressPlan_${planId}`;
  localStorage.setItem(inProgressKey, JSON.stringify(data));
}

function clearInProgressWorkoutData(planId) {
  const inProgressKey = `inProgressPlan_${planId}`;
  localStorage.removeItem(inProgressKey);
}
// +++ КІНЕЦЬ НОВИХ ФУНКЦІЙ +++

// Функції для роботи з токенами в localStorage
function setTokens(accessToken, refreshToken, expiresInSeconds) {
  localStorage.setItem('access_token', accessToken);
  if (refreshToken) {
    // Рефреш токен може не змінюватися при кожному оновленні
    localStorage.setItem('refresh_token', refreshToken);
  }

  // Розраховуємо та зберігаємо час закінчення access token
  const now = new Date().getTime();
  if (expiresInSeconds) {
    accessTokenExpiresAt = now + expiresInSeconds * 1000;
    //console.log(`Access token expires at: ${new Date(accessTokenExpiresAt).toLocaleString()}`);
  } else {
    // Якщо expires_in не надано, використовуємо дефолтний час життя
    accessTokenExpiresAt = now + DEFAULT_ACCESS_TOKEN_LIFETIME_MS;
    console.warn(
      `expires_in не надано, встановлено дефолтний час життя access token до: ${new Date(accessTokenExpiresAt).toLocaleString()}`
    );
  }
  localStorage.setItem(
    'access_token_expires_at',
    accessTokenExpiresAt.toString()
  );

  //console.log("Tokens set/updated in localStorage. Scheduling proactive refresh.");
  scheduleProactiveTokenRefresh(); // Плануємо наступне проактивне оновлення
}

function getAccessToken() {
  return localStorage.getItem('access_token');
}

function getRefreshToken() {
  return localStorage.getItem('refresh_token');
}

function getAccessTokenExpiresAt() {
  const timestampStr = localStorage.getItem('access_token_expires_at');
  return timestampStr ? parseInt(timestampStr, 10) : null;
}

function clearTokens() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('access_token_expires_at'); // Очищуємо час закінчення
  localStorage.removeItem('token'); // Старий ключ
  document.cookie = 'token=; path=/; max-age=0; SameSite=Lax; Secure';

  if (proactiveRefreshTimerId) {
    // Очищуємо таймер проактивного оновлення
    clearTimeout(proactiveRefreshTimerId);
    proactiveRefreshTimerId = null;
  }
  accessTokenExpiresAt = null;
  isRefreshing = false; // Скидаємо прапорець оновлення
  failedQueue = []; // Очищуємо чергу
  //console.log("Tokens and refresh timer cleared.");
}

// --- Логіка проактивного оновлення токена ---

/**
 * Планує наступну спробу проактивного оновлення токена.
 */
function scheduleProactiveTokenRefresh() {
  if (proactiveRefreshTimerId) {
    clearTimeout(proactiveRefreshTimerId); // Очищуємо попередній таймер
    proactiveRefreshTimerId = null;
  }

  const expiresAt = getAccessTokenExpiresAt();
  if (!expiresAt || !getRefreshToken()) {
    // Немає даних для оновлення або рефреш токена
    //console.log("Проактивне оновлення не заплановано: відсутній час закінчення або refresh token.");
    return;
  }

  const now = new Date().getTime();
  let refreshInMs = expiresAt - now - PROACTIVE_REFRESH_LEAD_TIME_MS;

  if (refreshInMs < 0) {
    // Якщо час вже минув або дуже близько
    refreshInMs = 5000; // Спробувати оновити через 5 секунд, якщо вже "пора"
    console.warn(
      `Час для планового оновлення токена вже близько або минув. Спроба через ${refreshInMs / 1000}с.`
    );
  }

  // Не плануємо, якщо час занадто малий (наприклад, менше 1 секунди)
  if (refreshInMs < 1000) {
    //console.log(`Проактивне оновлення не заплановано: розрахований час занадто малий (${refreshInMs}ms). Можливо, оновлення вже йде або не потрібне.`);
    return;
  }

  //console.log(`Наступне проактивне оновлення токена заплановано через: ${Math.round(refreshInMs / 1000)} секунд.`);
  proactiveRefreshTimerId = setTimeout(
    handleProactiveTokenRefresh,
    refreshInMs
  );
}

/**
 * Обробник для таймера проактивного оновлення.
 */
async function handleProactiveTokenRefresh() {
  //console.log("Спроба проактивного оновлення токена...");
  if (!getRefreshToken()) {
    //console.log("Проактивне оновлення скасовано: відсутній refresh token.");
    return;
  }
  if (isRefreshing) {
    //console.log("Проактивне оновлення відкладено: інший процес оновлення вже триває.");
    // Можна перепланувати на пізніше, якщо потрібно
    // scheduleProactiveTokenRefresh();
    return;
  }

  try {
    await performTokenRefreshWithRetries();
    // Якщо успішно, performTokenRefreshWithRetries викличе setTokens,
    // а setTokens викличе scheduleProactiveTokenRefresh для наступного циклу.
  } catch (error) {
    console.error(
      'Проактивне оновлення токена остаточно не вдалося після всіх спроб:',
      error
    );
    // Тут можна вирішити, чи потрібно виходити з системи, чи просто спробувати пізніше
    // Наприклад, можна просто очистити таймер і покластися на 401 обробку
    if (proactiveRefreshTimerId) {
      clearTimeout(proactiveRefreshTimerId);
      proactiveRefreshTimerId = null;
    }
    // Якщо помилка типу "invalid_grant" (невалідний рефреш токен), то виходимо
    if (
      error &&
      error.message &&
      error.message.toLowerCase().includes('invalid_grant')
    ) {
      console.warn(
        'Невалідний refresh token при проактивному оновленні. Вихід з системи.'
      );
      clearTokens();
      updateVisibility();
      alert(
        'Сесія закінчилася через недійсний токен оновлення. Будь ласка, увійдіть знову.'
      );
    }
    // Для інших помилок (наприклад, мережевих), можна нічого не робити і чекати 401
  }
}

/**
 * Виконує запит на оновлення токена з логікою повторних спроб.
 */
async function performTokenRefreshWithRetries() {
  if (isRefreshing) {
    // Додаткова перевірка
    //console.log("performTokenRefreshWithRetries: Оновлення вже триває, вихід.");
    // Якщо вже оновлюється, то цей виклик має чекати через failedQueue або інший механізм
    // Для простоти, якщо isRefreshing, то інший процес вже це робить.
    // Але якщо це викликано з 401, то isRefreshing вже буде true.
    // Ця функція має бути викликана тільки коли isRefreshing = false.
    return Promise.reject(new Error('Оновлення токенів вже триває.'));
  }

  isRefreshing = true;
  // Створюємо тимчасовий елемент для статусу, оскільки тут немає свого
  const statusIndicator =
    document.getElementById('session-status-indicator') || {};
  slowConnectionDetector.start(statusIndicator.id);
  //console.log("performTokenRefreshWithRetries: Розпочато оновлення токенів.");
  // Опціонально: показати індикатор "Оновлення сесії..." для користувача
  // displayStatus('session-status-indicator', 'Оновлення сесії...', false);

  try {
    const newTokens = await retryOperation(
      async () => {
        const refreshTokenValue = getRefreshToken();
        if (!refreshTokenValue) {
          console.warn(
            'performTokenRefreshWithRetries: Немає refresh token для оновлення.'
          );
          throw new Error('No refresh token available'); // Спеціальна помилка, щоб не робити ретраї
        }
        //console.log("performTokenRefreshWithRetries: Виклик /refresh з токеном:", refreshTokenValue ? refreshTokenValue.substring(0, 10) + '...' : 'none');

        const response = await fetch(`${baseURL}/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshTokenValue }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({
            detail: `Помилка сервера при оновленні: ${response.status}`,
          }));
          // Якщо помилка "invalid_grant", не потрібно робити ретраї
          if (
            response.status === 400 ||
            response.status === 401 ||
            (errorData.detail &&
              errorData.detail.toLowerCase().includes('invalid_grant'))
          ) {
            console.error(
              'performTokenRefreshWithRetries: Невалідний refresh token або інша критична помилка:',
              errorData.detail
            );
            throw {
              ...new Error(errorData.detail || 'Invalid refresh token'),
              noRetry: true,
            };
          }
          console.warn(
            `performTokenRefreshWithRetries: Спроба оновлення не вдалася (статус ${response.status}), спроба повтору...`
          );
          throw new Error(
            errorData.detail || `Refresh failed with status ${response.status}`
          );
        }
        return response.json();
      },
      RETRY_ATTEMPTS,
      RETRY_INITIAL_DELAY_MS,
      RETRY_BACKOFF_FACTOR
    );

    //console.log("performTokenRefreshWithRetries: Отримано нові токени:", newTokens);
    setTokens(
      newTokens.access_token,
      newTokens.refresh_token,
      newTokens.expires_in
    ); // expires_in з бекенду
    processQueue(null, newTokens.access_token); // Обробляємо чергу успішно
    return newTokens.access_token; // Повертаємо новий access token
  } catch (error) {
    console.error(
      'performTokenRefreshWithRetries: Критична помилка після всіх спроб оновлення токена:',
      error
    );
    clearTokens();
    updateVisibility();
    alert('Не вдалося оновити сесію. Будь ласка, увійдіть знову.');
    processQueue(error, null); // Відхиляємо очікуючі запити з помилкою
    throw error; // Прокидаємо помилку далі
  } finally {
    slowConnectionDetector.stop();
    isRefreshing = false;
    //console.log("performTokenRefreshWithRetries: Завершено процес оновлення токенів.");
    // displayStatus('session-status-indicator', '', false); // Сховати індикатор
  }
}

/**
 * Допоміжна функція для виконання операції з повторними спробами.
 * @param {Function} operation - Асинхронна функція, яку потрібно виконати.
 * @param {number} retries - Кількість максимальних спроб.
 * @param {number} delayMs - Початкова затримка між спробами.
 * @param {number} backoffFactor - Множник для збільшення затримки.
 * @param {number} attempt - Поточна спроба (для рекурсії).
 */
async function retryOperation(
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
      // Якщо помилка не для ретраю або спроби закінчились
      console.error(
        `retryOperation: Остання спроба (${attempt}/${retries}) не вдалася або помилка не для ретраю.`,
        error
      );
      throw error;
    }
    console.warn(
      `retryOperation: Спроба ${attempt}/${retries} не вдалася. Повтор через ${delayMs}ms. Помилка:`,
      error.message
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return retryOperation(
      operation,
      retries,
      delayMs * backoffFactor,
      backoffFactor,
      attempt + 1
    );
  }
}

// === ФУНКЦІЇ ДЛЯ РОБОТИ З WEB AUDIO API ===

/**
 * Асинхронно завантажує та розкодовує аудіофайл.
 * @param {string} url - Посилання на аудіофайл.
 * @returns {Promise<AudioBuffer>} - Обіцянка, що повертає розкодований аудіоб'єкт.
 */
async function loadAudioData(url) {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  return await audioContext.decodeAudioData(arrayBuffer);
}

/**
 * Ініціалізує звуки один раз і встановлює прапорці.
 */
async function initAudio() {
  // Якщо завантаження вже йде або завершено, нічого не робимо
  if (isAudioInitializing || areSoundsLoaded) return;

  isAudioInitializing = true; // Починаємо завантаження
  //console.log("Завантаження звукових ресурсів...");
  try {
    [tickBuffer, finishBuffer, finish2Buffer] = await Promise.all([
      loadAudioData(
        'https://limaxsport.top/static/sounds/timer-tick.mp3?v=1.1'
      ),
      loadAudioData(
        'https://limaxsport.top/static/sounds/timer-finish.mp3?v=1.2'
      ),
      loadAudioData(
        'https://limaxsport.top/static/sounds/timer-finish2.mp3?v=1.1'
      ),
    ]);
    areSoundsLoaded = true; // Завантаження успішне
    //console.log("Звукові ресурси успішно завантажено.");
  } catch (error) {
    console.error('Не вдалося завантажити звуки:', error);
    alert(
      'Не вдалося завантажити звуки для таймера. Спробуйте оновити сторінку.'
    );
  } finally {
    isAudioInitializing = false; // Завершуємо спробу завантаження
  }
}

/**
 * Надійно відтворює звук і викликає колбек через setTimeout.
 * @param {AudioBuffer} buffer - Розкодований звук.
 * @param {Function|null} onEndCallback - Функція, яка виконається після завершення звуку.
 */
function playSound(buffer, onEndCallback = null) {
  if (!areTimerSoundsEnabled || !buffer) {
    if (onEndCallback) onEndCallback();
    return;
  }

  // Запускаємо відтворення, як і раніше
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.start(0);

  // ОНОВЛЕНО: Замість події 'onended', використовуємо setTimeout з тривалістю звуку.
  if (onEndCallback) {
    // Отримуємо точну тривалість звуку в мілісекундах
    const durationMs = buffer.duration * 1000;
    setTimeout(onEndCallback, durationMs);
  }
}

/**
 * Наполегливо "будить" AudioContext. Безпечно викликати багато разів.
 */
function unlockAudioContext() {
  // .resume() безпечно викликати навіть на вже активному контексті.
  // Це надійно відновлює його після "сну" на мобільних пристроях.
  if (audioContext.state !== 'running') {
    audioContext.resume();
  }
}

/**
 * Додає "безпечний" обробник подій для кнопок, що працює і на ПК, і на мобільних.
 * Запобігає "проклікуванню" (click-through) на сенсорних екранах.
 * @param {HTMLElement} element - Елемент, до якого додаємо слухача.
 * @param {Function} callback - Функція, яка має виконатись.
 */
function addSafeEventListener(element, callback) {
  if (!element) return;

  let touchStarted = false;

  // Подія для сенсорних екранів
  element.addEventListener(
    'touchstart',
    () => {
      touchStarted = true;
    },
    { passive: true }
  );

  // Подія для сенсорних екранів, коли палець відривається
  element.addEventListener('touchend', (event) => {
    if (touchStarted) {
      // Запобігаємо генерації "фантомного" кліку після цього
      event.preventDefault();
      callback(event);
    }
    touchStarted = false;
  });

  // Подія для мишки (ПК)
  element.addEventListener('click', (event) => {
    // Якщо це був дотик, 'touchend' вже виконав функцію.
    // Цей 'click' є "фантомним", і ми його ігноруємо.
    if (touchStarted) {
      touchStarted = false; // Просто скидаємо прапорець
      return;
    }
    // Якщо це справжній клік мишкою, виконуємо функцію.
    callback(event);
  });
}

// --- Допоміжні функції для відображення тексту в "Мій профіль" ---

function getGoalText(value) {
  if (!value) return 'Не вказано';
  const map = {
    'lose weight': 'Схуднути',
    'gain muscle mass': "Набрати м'язову масу",
    'maintain shape': 'Підтримувати форму',
  };
  return map[value] || value;
}

function getActivityText(value) {
  if (!value) return 'Не вказано';
  const map = {
    low: 'Низька',
    average: 'Середня',
    high: 'Висока',
  };
  return map[value] || value;
}

function getTrainingTypeText(value) {
  if (!value) return 'Не вказано';
  const map = {
    gym: 'Тренування в тренажерному залі',
    home: 'Домашні та вуличні тренування',
    both: 'Обидва варіанти',
  };
  return map[value] || value;
}

function getTrainingLevelText(value) {
  if (!value) return 'Не вказано';
  const map = {
    low: 'Низький',
    average: 'Середній',
    high: 'Високий',
  };
  return map[value] || value;
}

function getTrainingDaysText(value) {
  if (value === null || value === undefined) return 'Не вказано';
  return value.toString();
}

function getWeekdaysText(values) {
  if (!values || !Array.isArray(values) || values.length === 0) {
    return 'Не вказано';
  }
  const dayOrder = { Пн: 1, Вт: 2, Ср: 3, Чт: 4, Пт: 5, Сб: 6, Нд: 7 };
  return values
    .sort((a, b) => (dayOrder[a] || 8) - (dayOrder[b] || 8))
    .join(', ');
}

function getHealthProblemsText(values) {
  // values - це масив
  if (!values || values.length === 0) return 'Немає';
  const map = {
    knees: 'Колінні суглоби',
    spine: 'Хребет (поперековий відділ)',
    hips: 'Тазостегнові суглоби',
    shoulder: 'Плечові суглоби',
    heart: 'Серцево-судинна система',
    breath: 'Захворювання дихальної системи',
    other: 'Інше',
  };
  return values.map((v) => map[v] || v).join(', ') || 'Немає';
}

const productNameMap = {
  milk: 'Молоко',
  cottage_cheese: 'Творог',
  yogurt: 'Йогурт',
  sour_cream: 'Сметана',
  cheese: 'Сир',
  eggs: 'Яйця',
  chicken: 'Курка',
  turkey: 'Індичка',
  pork: 'Свинина',
  beef: 'Яловичина',
  shank: 'Шинка',
  offal: 'Субпродукти',
  salted_fish: 'Солона риба',
  cooked_fish: 'Риба приготовлена',
  shrimps: 'Креветки',
  squid: 'Кальмари',
  caviar: 'Ікра',
  cod_liver: 'Печінка тріски',
  canned_fish: 'Консервована риба',
  oatmeal: 'Вівсянка',
  buckwheat: 'Гречка',
  rice: 'Рис',
  bulgur: 'Булгур',
  pasta: 'Макарони',
  spaghetti: 'Спагетті',
  corn_grits: 'Кукурудзяна крупа',
  quinoa: 'Кіноа',
  couscous: 'Кускус',
  semolina: 'Манна крупа',
  pearl_barley: 'Перлівка',
  millet: 'Пшоно',
  barley_groats: 'Ячна крупа',
  flakes: 'Пластівці',
  potato: 'Картопля',
  sweet_potato: 'Батат',
  bread: 'Хліб',
  pita: 'Лаваш',
  tortilla: 'Тортілья',
  breadsticks: 'Хлібці',
  nuts: 'Горіхи',
  peanut_butter: 'Арахісова паста',
  peas: 'Горох',
  lentils: 'Сочевиця',
  beans: 'Квасоля',
  butter: 'Масло вершкове',
  olive: 'Оливки',
  mushrooms: 'Гриби',
  beet: 'Буряк',
  onion: 'Цибуля',
  tomatoes: 'Помідори (томатна паста)',
  canned_vegetables: 'Консервовані овочі',
  zucchini: 'Кабачки',
  eggplants: 'Баклажани',
  pumpkin: 'Гарбуз',
  avocado: 'Авокадо',
  banana: 'Банани',
  apples: 'Яблука',
  pears: 'Груші',
  orange: 'Апельсини',
  lemon: 'Лимони',
  kiwi: 'Ківі',
  strawberry: 'Полуниця',
  dried_fruits: 'Сухофрукти',
  jam: 'Варення/джем',
  marshmallow: 'Зефір',
  lukum: 'Лукум',
  protein: 'Протеїн (спортпіт)',
};

function getProductsText(values) {
  // values - це масив англійських ключів
  if (!values || !Array.isArray(values) || values.length === 0) {
    return 'Немає'; // Якщо немає значень або це не масив
  }
  return values
    .map((value) => {
      // Шукаємо українську назву в productNameMap
      // Якщо не знайдено, повертаємо оригінальне значення (або можна повернути value з великої літери)
      return (
        productNameMap[value] ||
        value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ')
      );
    })
    .join(', ');
}

function getNumberOfMealsText(value) {
  if (!value) return 'Не вказано';
  const map = {
    two: '2',
    three: '3',
    four: '4',
  };
  return map[value] || value;
}

/**
 * Функція для форматування тексту, що замінює символи нового рядка (\n)
 * на HTML-теги розриву рядка (<br>).
 * @param {string} text - Вхідний текст для форматування.
 * @returns {string} - Відформатований HTML-рядок.
 */
function formatTextWithLineBreaks(text) {
  if (!text) {
    return ''; // Повертаємо порожній рядок, якщо тексту немає
  }
  // Використовуємо регулярний вираз /\\n/g для заміни ВСІХ входжень \\n
  return text.replace(/\n/g, '<br>');
}

/**
 * ОНОВЛЕНО: Додано "наполегливу" прокрутку для боротьби зі стрибками на мобільних.
 */
function updateVisibility() {
  const loginOverlay = document.getElementById('login-overlay');
  const cabinetDiv = document.getElementById('cabinet');

  if (isAuthorized()) {
    if (loginOverlay) loginOverlay.style.display = 'none';
    if (cabinetDiv) cabinetDiv.style.display = 'block';

    // --- НОВА ЛОГІКА ПРОКРУТКИ ---
    // Миттєво прокручуємо догори кількома способами для сумісності
    window.scrollTo(0, 0);
    document.body.scrollTop = 0;
    document.documentElement.scrollTop = 0;

    // Повторюємо прокрутку через короткі проміжки часу,
    // щоб "перебити" будь-яке автоматичне прокручування браузера,
    // яке може статися після зникнення клавіатури.
    setTimeout(() => window.scrollTo(0, 0), 50);
    setTimeout(() => window.scrollTo(0, 0), 150);
    // --- КІНЕЦЬ НОВОЇ ЛОГІКИ ---
  } else {
    if (loginOverlay) loginOverlay.style.display = 'flex';
    if (cabinetDiv) cabinetDiv.style.display = 'none';
  }
}

/**
 * ОНОВЛЕНО (v3): Керує доступністю вкладок, враховуючи тип реєстрації користувача.
 * @param {boolean} hasActiveSubscription - Прапорець, що вказує на наявність активної підписки.
 * @param {object|null} userProfile - Об'єкт профілю користувача для перевірки типу реєстрації.
 */
function updateTabAccessibility(hasActiveSubscription, userProfile = null) {
  const allTabs = document.querySelectorAll('.tab-link');

  // Визначаємо, які вкладки доступні для користувача БЕЗ підписки
  let allowedTabsWithoutSub = ['subscription', 'logout'];
  if (userProfile && userProfile.registration_type === 'self') {
    // Для користувача "без тренера" додаємо ТІЛЬКИ вкладку "План"
    allowedTabsWithoutSub.push('plan');
  }

  allTabs.forEach((tab) => {
    const tabName = tab.dataset.tabName;
    if (!tabName) return;

    if (hasActiveSubscription) {
      // Якщо підписка є, робимо ВСІ вкладки активними
      tab.classList.remove('tab-disabled');
    } else {
      // Якщо підписки немає, перевіряємо, чи входить вкладка до списку дозволених
      if (allowedTabsWithoutSub.includes(tabName)) {
        tab.classList.remove('tab-disabled'); // Дозволена
      } else {
        tab.classList.add('tab-disabled'); // Недозволена - блокуємо
      }
    }
  });
}

// Функція для автоматичного зміни висоти textarea
function autoResize(textarea) {
  if (textarea) {
    textarea.style.height = 'auto'; // Скидаємо висоту
    textarea.style.height = textarea.scrollHeight + 'px'; // Встановлюємо по контенту
  }
}

// Глобальні змінні для HTML опцій селектів (використовуватимуться в generateEditableSetsTableHTML)
const USER_REPS_OPTIONS =
  '<option value="">--</option>' +
  Array.from(
    { length: 50 },
    (_, i) => `<option value="${i + 1}">${i + 1}</option>`
  ).join('');
const USER_WEIGHT_OPTIONS =
  '<option value="">--</option>' +
  Array.from(
    { length: 300 },
    (_, i) => `<option value="${i + 1}">${i + 1} кг</option>`
  ).join('');
const USER_TIME_OPTIONS =
  '<option value="">--</option>' +
  Array.from({ length: 60 }, (_, i) => {
    // від 5 до 300 секунд
    const seconds = (i + 1) * 5;
    return `<option value="${seconds}">${seconds} сек</option>`;
  }).join('');

/**
 * Форматує секунди у рядок "хх:сс".
 * @param {number|null|undefined} totalSeconds Загальна кількість секунд.
 * @returns {string} Відформатований час або '-'.
 */
function formatSecondsToMMSS(totalSeconds) {
  if (
    totalSeconds === null ||
    totalSeconds === undefined ||
    totalSeconds <= 0
  ) {
    return '-'; // Повертаємо тире, якщо час не вказано або 0
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  // padStart(2, '0') додає ведучий нуль, якщо число < 10
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
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
    // Встановлюємо колір залежно від помилки, але можна налаштувати класи CSS
    statusDiv.style.color = isError ? 'red' : 'lightgreen';
    // Скидаємо попередній таймер очищення, якщо він є
    if (statusDiv.clearTimeoutId) {
      clearTimeout(statusDiv.clearTimeoutId);
    }
    if (clearAfterMs > 0) {
      statusDiv.clearTimeoutId = setTimeout(() => {
        // Перевіряємо, чи повідомлення все ще те саме, перш ніж очистити
        if (statusDiv.innerText === message) {
          statusDiv.innerText = '';
          statusDiv.style.color = ''; // Повертаємо стандартний колір CSS
        }
      }, clearAfterMs);
    }
  } else {
    // Виводимо в консоль, якщо елемент статусу не знайдено
    console[isError ? 'error' : 'warn'](
      `Елемент статусу з ID "${elementId}" не знайдено. Повідомлення: ${message}`
    );
  }
}

/**
 * ВИПРАВЛЕНО: Обгортка для fetch, яка тепер не має глобального обробника 402.
 * Відповідальність за обробку 402 перенесена на функції, що її викликають.
 */
async function fetchWithAuth(url, options = {}) {
  let token = getAccessToken();

  const headers = {
    ...options.headers,
    'Content-Type': options.headers?.['Content-Type'] || 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let fetchOptions = { ...options, headers };

  try {
    //console.log(`fetchWithAuth: Запит до ${url}`);
    let response = await fetch(url, fetchOptions);

    if (response.status === 401 && getRefreshToken()) {
      if (!isRefreshing) {
        //console.log("fetchWithAuth: Запуск оновлення токена через 401.");
        try {
          const newAccessToken = await performTokenRefreshWithRetries();
          fetchOptions.headers['Authorization'] = `Bearer ${newAccessToken}`;
          //console.log(`fetchWithAuth: Повторний запит до ${url} з новим токеном.`);
          response = await fetch(url, fetchOptions); // Повторюємо запит
        } catch (refreshError) {
          console.error(
            'fetchWithAuth: Помилка оновлення токена після 401.',
            refreshError
          );
          throw refreshError; // Прокидаємо помилку далі
        }
      } else {
        //console.log(`fetchWithAuth: Оновлення вже триває, запит до ${url} додано до черги.`);
        const newAccessTokenFromQueue = await new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        });
        fetchOptions.headers['Authorization'] =
          `Bearer ${newAccessTokenFromQueue}`;
        //console.log(`fetchWithAuth: Повторний запит (з черги) до ${url}.`);
        response = await fetch(url, fetchOptions); // Повторюємо запит з черги
      }
    }

    // --- Обробка специфічних статусів помилок ---
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({
        detail: `Помилка сервера: ${response.status}`,
      }));

      // Помилка 402: Потрібна оплата
      if (response.status === 402) {
        console.warn('Отримано статус 402: потрібна підписка.');
        // Перенаправляємо на вкладку підписки
        const subscriptionTabButton = document.querySelector(
          '.tab-link[data-tab-name="subscription"]'
        );
        if (subscriptionTabButton) {
          openTab({ currentTarget: subscriptionTabButton }, 'subscription');
        }
        // Створюємо та прокидаємо помилку, щоб зупинити подальше виконання
        throw new Error(errorData.detail || 'Потрібна активна підписка.');
      }

      // Помилка 403: Доступ заборонено (напр., акаунт призупинено)
      if (response.status === 403) {
        console.warn(
          'Отримано статус 403: доступ заборонено.',
          errorData.detail
        );
        // Якщо помилка про призупинення, виходимо з системи
        if (
          errorData.detail &&
          errorData.detail.toLowerCase().includes('призупинено')
        ) {
          alert(
            `Доступ заборонено: ${errorData.detail}\nВи будете перенаправлені на сторінку входу.`
          );
          // Використовуємо кнопку виходу для коректного завершення сесії
          const logoutButton = document.getElementById('confirm-logout');
          if (logoutButton) logoutButton.click();
        }
        // Прокидаємо помилку, щоб показати повідомлення
        throw new Error(errorData.detail || 'Доступ заборонено.');
      }
    }

    const responseData = await response.json().catch(() => {
      if (response.ok) return null;
      return { detail: `Помилка сервера: ${response.status}` };
    });

    // Повертаємо об'єкт з розпарсеними даними та оригінальною відповіддю
    return { data: responseData, response: response };
  } catch (error) {
    console.error(
      `fetchWithAuth: Загальна помилка під час запиту до ${url}:`,
      error
    );
    throw error; // Прокидаємо помилку далі
  }
}

/**
 * Показує модальне вікно з повідомленням про новий 30-денний план.
 * @returns {Promise<void>}
 */
function showNewPlanNotificationModal() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('new-plan-notification-overlay');
    const modal = document.getElementById('new-plan-notification-modal');
    const messageEl = document.getElementById('new-plan-notification-message');
    const okBtn = document.getElementById('new-plan-notification-ok-btn');

    if (!overlay || !modal || !messageEl || !okBtn) {
      console.error('Елементи модального вікна про новий план не знайдені!');
      resolve();
      return;
    }

    messageEl.innerHTML =
      "Чудові новини! ✨<br>Ми підготували для вас новий тренувальний план на наступні 30 днів. Ви можете знайти його у вкладці 'План'.";

    const closeModal = () => {
      overlay.style.display = 'none';
      modal.style.display = 'none';
      resolve();
    };

    okBtn.replaceWith(okBtn.cloneNode(true));
    document
      .getElementById('new-plan-notification-ok-btn')
      .addEventListener('click', closeModal);
    overlay.addEventListener('click', closeModal);

    overlay.style.display = 'block';
    modal.style.display = 'flex';
  });
}

/**
 * Керує логікою модального вікна вибору днів для тренувань.
 * @param {object} planToSchedule - План, для якого потрібно згенерувати тренування.
 * @param {object} userProfile - Повний профіль користувача.
 * @returns {Promise<void>}
 */
function showDaySelectorModal(planToSchedule, userProfile) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('day-selector-modal-overlay');
    const modal = document.getElementById('day-selector-modal');
    if (!overlay || !modal) {
      console.error('Елементи модального вікна вибору днів не знайдені!');
      resolve();
      return;
    }

    const expectedDaysCount = userProfile.training_days_per_week;
    const previouslySelectedDays =
      userProfile.preferred_training_weekdays || [];

    let modalHTML = `
            <div class="custom-modal-content">
                <h4>Оберіть зручні дні для тренувань</h4>
                <p>Вам необхідно обрати рівно <strong>${expectedDaysCount} дні(в)</strong> на тиждень для силових тренувань.</p>
                ${previouslySelectedDays.length > 0 ? `<p class="form-hint">Ваші попередні налаштування: <strong>${getWeekdaysText(previouslySelectedDays)}</strong>. Ви можете їх підтвердити або обрати нові.</p>` : ''}
                
                <div id="day-selector-grid" class="checkbox-group-container" style="margin: 20px 0;">
                    <label class="custom-checkbox-label"><input type="checkbox" name="preferred_day" value="Пн"> Пн</label>
                    <label class="custom-checkbox-label"><input type="checkbox" name="preferred_day" value="Вт"> Вт</label>
                    <label class="custom-checkbox-label"><input type="checkbox" name="preferred_day" value="Ср"> Ср</label>
                    <label class="custom-checkbox-label"><input type="checkbox" name="preferred_day" value="Чт"> Чт</label>
                    <label class="custom-checkbox-label"><input type="checkbox" name="preferred_day" value="Пт"> Пт</label>
                    <label class="custom-checkbox-label"><input type="checkbox" name="preferred_day" value="Сб"> Сб</label>
                    <label class="custom-checkbox-label"><input type="checkbox" name="preferred_day" value="Нд"> Нд</label>
                </div>
                <small id="day-selector-hint" class="form-hint">Обрано 0 з ${expectedDaysCount}</small>
                
                <div class="custom-modal-buttons">
                    <button id="confirm-schedule-btn" class="modal-confirm-action-btn">Підтвердити</button>
                </div>
                <div id="day-selector-status" class="status-message" style="margin-top: 10px;"></div>
            </div>
        `;
    modal.innerHTML = modalHTML;

    const confirmBtn = document.getElementById('confirm-schedule-btn');
    const statusDiv = document.getElementById('day-selector-status');
    const hint = document.getElementById('day-selector-hint');
    const grid = document.getElementById('day-selector-grid');

    // Заповнюємо чекбокси на основі попереднього вибору
    grid.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      if (previouslySelectedDays.includes(cb.value)) {
        cb.checked = true;
      }
    });

    const updateHint = () => {
      const checkedCount = grid.querySelectorAll('input:checked').length;
      hint.textContent = `Обрано ${checkedCount} з ${expectedDaysCount}`;
      hint.style.color =
        checkedCount !== expectedDaysCount && checkedCount > 0
          ? '#ffc107'
          : '#aaa';
    };
    updateHint();

    grid.addEventListener('change', updateHint);

    const closeModal = () => {
      overlay.style.display = 'none';
      resolve();
    };

    confirmBtn.addEventListener('click', () => {
      // Забираємо async, він тут більше не потрібен
      const selectedDays = Array.from(
        grid.querySelectorAll('input:checked')
      ).map((cb) => cb.value);

      // Встановлюємо в localStorage мітку, що генерація для цього плану почалася.
      // Мітка буде жити 10 хвилин, щоб уникнути вічного блокування у разі помилки.
      localStorage.setItem(
        `generation_in_progress_${planToSchedule.id}`,
        Date.now()
      );

      if (selectedDays.length !== expectedDaysCount) {
        displayStatus(
          'day-selector-status',
          `Будь ласка, оберіть рівно ${expectedDaysCount} дні(в).`,
          true,
          4000
        );
        return;
      }

      // 1. Одразу показуємо фінальне повідомлення
      modal.innerHTML = `
                <div class="custom-modal-content">
                    <h4>Чудово!</h4>
                    <p>Генерація тренувань на наступний тиждень розпочалась. 🚀 Приблизно через 2 хвилини ви побачите їх у вкладці "Тренування".</p>
                    <p class="form-hint">Наступні генерації відбуватимуться автоматично кожного наступного тижня за наявності активної підписки. ✨ Бажані дні тренувань ви завжди можете змінити у профілі, після чого наступна генерація буде запланована на нові дні.</p>
                    <div class="custom-modal-buttons">
                        <button id="final-ok-btn" class="modal-confirm-action-btn">Зрозуміло</button>
                    </div>
                </div>
            `;
      document
        .getElementById('final-ok-btn')
        .addEventListener('click', closeModal);

      // 2. Відправляємо запит на генерацію у фоновому режимі
      fetchWithAuth(
        `${baseURL}/plans/${planToSchedule.id}/schedule-and-generate`,
        {
          method: 'POST',
          body: JSON.stringify({ preferred_days: selectedDays }),
        }
      )
        .then(({ response, data }) => {
          if (!response.ok) {
            // Якщо у фоні сталася помилка, просто виводимо її в консоль,
            // оскільки користувач вже пішов з цього вікна.
            console.error(
              'Помилка фонової генерації тренувань:',
              data.detail || 'Невідома помилка'
            );
          } else {
            console.log('Фонова генерація тренувань успішно запущена.');
          }
        })
        .catch((error) => {
          console.error(
            'Критична помилка під час запиту на фонову генерацію:',
            error
          );
        });
    });

    overlay.style.display = 'block';
    modal.style.display = 'flex';
  });
}

// --- Кастомний модальний діалог для підтвердження (ОНОВЛЕНА ВЕРСІЯ) ---

function showCustomConfirmationDialog(message, onConfirm) {
  // Отримуємо посилання на ВСІ необхідні елементи
  const overlay = document.getElementById('custom-confirm-overlay');
  const modal = document.getElementById('custom-confirm-modal');
  const textElement = document.getElementById('confirmationMessageText');
  const yesButton = document.getElementById('modalConfirmActionBtn');
  const noButton = document.getElementById('modalCancelActionBtn');

  // Перевірка, чи всі елементи існують
  if (!overlay || !modal || !textElement || !yesButton || !noButton) {
    console.error(
      'Елементи кастомного модального вікна не знайдені! Використовується стандартний confirm.'
    );
    if (confirm(message)) {
      onConfirm();
    }
    return;
  }

  // 1. Встановлюємо текст повідомлення
  textElement.textContent = message;

  // 2. Функція для закриття вікна
  const closeModal = () => {
    overlay.style.display = 'none';
    modal.style.display = 'none';
  };

  // 3. Перестворюємо кнопки, щоб очистити всі попередні обробники подій
  // Це найнадійніший спосіб уникнути дублювання
  yesButton.replaceWith(yesButton.cloneNode(true));
  noButton.replaceWith(noButton.cloneNode(true));

  // 4. Додаємо нові обробники до "свіжих" кнопок
  document
    .getElementById('modalConfirmActionBtn')
    .addEventListener('click', () => {
      onConfirm();
      closeModal();
    });

  document
    .getElementById('modalCancelActionBtn')
    .addEventListener('click', closeModal);
  overlay.addEventListener('click', closeModal); // Закриваємо по кліку на фон

  // 5. Показуємо ОБИДВА елементи
  overlay.style.display = 'block';
  modal.style.display = 'block'; // або 'flex', якщо ви використовуєте flexbox для центрування
}
// --- Кінець кастомного модального діалогу ---

// Функція для передзавантаження першого GIF (використовує fetchWithAuth)
async function preloadFirstActiveWorkoutGif() {
  //console.log("Спроба передзавантажити перший GIF активного тренування...");
  if (!isAuthorized()) {
    //console.log("Передзавантаження скасовано: користувач не авторизований.");
    return;
  }

  try {
    // 1. Отримуємо список тренувань. Дані вже в змінній 'plans'
    const { data: plans, response: responsePlans } = await fetchWithAuth(
      `${baseURL}/training_plans`
    );

    if (!responsePlans.ok) {
      const errorText =
        plans?.detail || `Помилка сервера: ${responsePlans.status}`;
      console.warn(
        `Помилка отримання списку тренувань для передзавантаження: ${errorText}`
      );
      return;
    }

    // 2. Знаходимо перше невиконане тренування
    const firstUncompletedPlan = plans.find((plan) => !plan.completed);
    if (!firstUncompletedPlan) {
      //console.log("Передзавантаження: Не знайдено активних (невиконаних) тренувань.");
      return;
    }
    const planId = firstUncompletedPlan.id;
    //console.log(`Передзавантаження: Знайдено активне тренування ID: ${planId}`);

    // 3. Отримуємо деталі цього тренування. Дані вже в 'planDetails'
    const { data: planDetails, response: responseDetails } =
      await fetchWithAuth(`${baseURL}/training_plans/${planId}`);

    if (!responseDetails.ok) {
      const errorText =
        planDetails?.detail || `Помилка сервера: ${responseDetails.status}`;
      console.warn(
        `Помилка отримання деталей тренування ID ${planId} для передзавантаження: ${errorText}`
      );
      return;
    }

    // 4. Знаходимо першу вправу та ініціюємо передзавантаження GIF
    if (planDetails.exercises && Array.isArray(planDetails.exercises)) {
      const firstExercise = planDetails.exercises.find((ex) => ex.order === 1);
      if (firstExercise && firstExercise.gif && firstExercise.gif.filename) {
        const gifFilename = firstExercise.gif.filename;
        const gifUrlToPreload = `https://limaxsport.top/static/gifs/${gifFilename}`;

        //console.log(`Передзавантаження GIF: ${gifUrlToPreload}`);
        const preloader = new Image();
        preloader.src = gifUrlToPreload;
        preloader.onerror = () => {
          console.error(`Помилка передзавантаження GIF: ${gifUrlToPreload}`);
        };
        preloader.onload = () => {
          //console.log(`GIF ${gifUrlToPreload} успішно передзавантажено в кеш.`);
        };
      } else {
        //console.log(`Передзавантаження: У тренуванні ID ${planId} не знайдено вправу з order=1 або її GIF.`);
      }
    } else {
      //console.log(`Передзавантаження: У тренуванні ID ${planId} відсутні вправи.`);
    }
  } catch (error) {
    console.error('Помилка під час передзавантаження першого GIF:', error);
  }
}

// --- API функції для Лайків ---
async function likeUserProfileAPI(targetUserPhone) {
  const { data, response } = await fetchWithAuth(
    `${baseURL}/community/users/${targetUserPhone}/like`,
    {
      method: 'POST',
      // Тіло запиту не потрібне, якщо бекенд його не очікує для POST /like
    }
  );
  if (!response.ok) {
    // У data вже може бути помилка, якщо json() в fetchWithAuth її розпарсив
    throw new Error(
      data?.detail ||
        `Помилка сервера: ${response.status} - ${response.statusText}`
    );
  }
  return data; // <-- ВИПРАВЛЕНО. Повертаємо вже готові дані
}

async function unlikeUserProfileAPI(targetUserPhone) {
  const { data, response } = await fetchWithAuth(
    `${baseURL}/community/users/${targetUserPhone}/like`,
    {
      method: 'DELETE',
    }
  );
  if (!response.ok) {
    throw new Error(
      data?.detail ||
        `Помилка сервера: ${response.status} - ${response.statusText}`
    );
  }
  return data; // <-- ВИПРАВЛЕНО. Повертаємо вже готові дані
}

// --- ВКЛАДКА "ПОВІДОМЛЕННЯ" --- ///
// Функція для завантаження та відображення повідомлень
async function loadAndDisplayNotifications() {
  const container = document.getElementById('notifications');
  if (!container) return;

  container.innerHTML = '<p>Завантаження повідомлень...</p>';

  try {
    const { data: notifications, response } = await fetchWithAuth(
      `${baseURL}/notifications`
    );
    if (!response.ok) {
      throw new Error(
        notifications.detail || 'Не вдалося завантажити повідомлення'
      );
    }

    let content = `<p class="notifications-intro-text">В цій вкладці вам будуть надходити важливі повідомлення від команди Lily & Max sport, а також інформація про внесені оновлення в функціонал особистого кабінету.</p>`;

    if (!notifications || notifications.length === 0) {
      content += '<p>Нових повідомлень немає.</p>';
      container.innerHTML = content;
      return;
    }

    const unreadIds = [];
    content += '<div id="notifications-container" class="notification-list">'; // Додано ID для CSS

    notifications.forEach((msg) => {
      if (!msg.is_read) {
        unreadIds.push(msg.id);
      }
      const date = new Date(msg.created_at).toLocaleString('uk-UA', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      // ▼▼▼ ОСНОВНА ЗМІНА ТУТ - НОВИЙ, ПРОСТІШИЙ HTML-ШАБЛОН ▼▼▼
      content += `
                <div class="notification-item ${!msg.is_read ? 'is-unread' : 'is-read'}" data-notification-id="${msg.id}">
                    <h5 class="notification-title">${msg.title}</h5>
                    <p class="notification-date">${date}</p>
                    <p class="notification-text">${msg.text}</p>
                </div>
            `;
      // ▲▲▲ КІНЕЦЬ ЗМІНИ ▲▲▲
    });
    content += '</div>';
    container.innerHTML = content;

    // Якщо були непрочитані повідомлення
    if (unreadIds.length > 0) {
      updateNotificationBadge(0);

      fetchWithAuth(`${baseURL}/notifications/mark-as-read`, {
        method: 'POST',
        body: JSON.stringify({ notification_ids: unreadIds }),
      }).catch((err) =>
        console.error('Не вдалося позначити повідомлення як прочитані:', err)
      );

      setTimeout(() => {
        const unreadElements = container.querySelectorAll(
          '.notification-item.is-unread'
        );
        unreadElements.forEach((el) => el.classList.remove('is-unread'));
      }, 3000);
    }
  } catch (error) {
    container.innerHTML = `<p style="color:red;">Помилка: ${error.message}</p>`;
  }
}

// Функція для оновлення лічильника
function updateNotificationBadge(count) {
  const badge = document.querySelector(
    '.tab-link[data-tab-name="notifications"] .notification-badge'
  );
  if (!badge) return;

  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

/**
 * Отримує та відображає кількість непрочитаних повідомлень.
 */
async function fetchAndDisplayUnreadCount() {
  const badge = document.getElementById('notification-badge-id');
  if (!badge) {
    console.warn(
      'Елемент для лічильника повідомлень (#notification-badge-id) не знайдено.'
    );
    return;
  }

  try {
    // ▼▼▼ ОСНОВНА ЗМІНА ТУТ ▼▼▼
    // Ми додаємо змінну baseURL, щоб створити повний, правильний URL
    const { data } = await fetchWithAuth(
      `${baseURL}/notifications/unread-count`
    );
    // ▲▲▲ КІНЕЦЬ ЗМІНИ ▲▲▲

    const count = data.unread_count;

    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-block'; // Показуємо лічильник
    } else {
      badge.style.display = 'none'; // Ховаємо, якщо нових повідомлень немає
    }
  } catch (error) {
    console.error(
      'Помилка завантаження кількості непрочитаних повідомлень:',
      error
    );
    badge.style.display = 'none'; // Ховаємо лічильник у разі помилки
  }
}
// -- КІНЕЦЬ вкладки "Повідомлення" -- //

// --- Функції для вкладки "Підписка" (ФІНАЛЬНА ВЕРСІЯ) ---

// === ПОЧАТОК БЛОКУ ЛОГІКИ НАГАДУВАННЯ ПРО ПІДПИСКУ ===
function formatDaysWord(number) {
  const lastDigit = number % 10;
  const lastTwoDigits = number % 100;
  if (lastDigit === 1 && lastTwoDigits !== 11) {
    return 'день';
  }
  if ([2, 3, 4].includes(lastDigit) && ![12, 13, 14].includes(lastTwoDigits)) {
    return 'дні';
  }
  return 'днів';
}

function showReminderModal(daysLeft) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('custom-confirm-overlay');
    const modal = document.getElementById('subscription-reminder-modal');
    const messageEl = document.getElementById('reminder-modal-message');
    const okBtn = document.getElementById('reminder-modal-ok-btn');

    if (!overlay || !modal || !messageEl || !okBtn) {
      console.error('Елементи модального вікна нагадування не знайдені!');
      resolve();
      return;
    }

    const daysWord = formatDaysWord(daysLeft);
    messageEl.innerHTML = `Ваша підписка закінчиться через <strong>${daysLeft} ${daysWord}</strong>. Ви можете продовжити її у будь-який час у вкладці "Підписка".`;

    const closeModal = () => {
      overlay.style.display = 'none';
      modal.style.display = 'none';
      resolve();
    };

    okBtn.replaceWith(okBtn.cloneNode(true));
    document
      .getElementById('reminder-modal-ok-btn')
      .addEventListener('click', closeModal);
    overlay.addEventListener('click', closeModal);

    overlay.style.display = 'block';
    modal.style.display = 'flex';
  });
}

/**
 * ОНОВЛЕНО: Головна функція, що перевіряє, чи потрібно показувати нагадування,
 * враховуючи статус автопоновлення.
 */
async function checkAndShowSubscriptionReminder() {
  if (!isAuthorized()) return;

  try {
    // Переконуємось, що дані профілю завантажені
    if (!currentUserProfileData) {
      currentUserProfileData = await fetchCurrentProfileDataOnce();
    }

    // --- ОСНОВНА ЗМІНА ТУТ ---
    // Показуємо нагадування, тільки якщо автопоновлення ВИМКНЕНО
    if (
      currentUserProfileData &&
      currentUserProfileData.auto_renew_enabled === true
    ) {
      // console.log("Автопоновлення увімкнено, нагадування про закінчення підписки не потрібне.");
      return; // Виходимо з функції
    }

    const { data: subscriptions, response } = await fetchWithAuth(
      `${baseURL}/api/my-subscriptions`
    );
    if (!response.ok) return;

    const activeSubscription = (subscriptions || [])
      .filter(
        (sub) => sub.status === 'active' && new Date(sub.end_date) > new Date()
      )
      .sort((a, b) => new Date(b.end_date) - new Date(a.end_date))[0];

    if (!activeSubscription) return;

    const endDate = new Date(activeSubscription.end_date);
    const now = new Date();
    const timeDiff = endDate.getTime() - now.getTime();
    const daysLeft = Math.ceil(timeDiff / (1000 * 3600 * 24));

    if (daysLeft > 0 && daysLeft <= 3) {
      await showReminderModal(daysLeft);
    }
  } catch (error) {
    console.error('Помилка під час перевірки нагадування про підписку:', error);
  }
}
// === КІНЕЦЬ БЛОКУ ЛОГІКИ НАГАДУВАННЯ ПРО ПІДПИСКУ ===

function translateField(field, value) {
  const translations = {
    subscription_type: {
      weekly: 'Тижнева',
      monthly: 'Місячна',
      quarterly: 'Квартальна (3 місяці)',
      semi_annual: 'Піврічна',
      annual: 'Річна',
    },
  };
  if (!translations[field] || !value) return value || 'Не вказано';
  return translations[field][value] || value;
}

function generatePaymentBlockHTML(userData, userSubscriptions) {
  let plans = [];
  let planTypeForAPI = 'with_trainer';
  let blockTitle = 'Оформити або продовжити підписку "З тренером"';

  // Перевіряємо, чи є у користувача ВЗАГАЛІ будь-які успішні підписки (активні або завершені)
  const isFirstEverPayment = !userSubscriptions.some(
    (sub) => sub.status === 'active' || sub.status === 'expired'
  );

  const hasPreviousPayment = userSubscriptions.some(
    (sub) => sub.plan_type === 'without_trainer' && sub.status === 'active'
  );

  if (userData && userData.registration_type === 'self') {
    planTypeForAPI = 'without_trainer';
    blockTitle = 'Оформити підписку "Без тренера"';

    if (hasPreviousPayment) {
      plans = [
        {
          type: 'weekly',
          name: 'Тижнева',
          price: '200 грн',
          daily: '~28 грн/день',
        },
        {
          type: 'monthly',
          name: 'Місячна',
          price: '600 грн',
          daily: '~20 грн/день',
        },
        {
          type: 'quarterly',
          name: 'Квартальна',
          price: '1 500 грн',
          daily: '~16 грн/день',
        },
        {
          type: 'semi_annual',
          name: 'Піврічна',
          price: '2 700 грн',
          daily: '~15 грн/день',
        },
        {
          type: 'annual',
          name: 'Річна',
          price: '4 800 грн',
          daily: '~13 грн/день',
        },
      ];
    } else {
      plans = [
        {
          type: 'weekly',
          name: 'Тижнева',
          price: '99 грн',
          daily: '~14 грн/день',
          old_price: '250 грн',
          promo_text:
            'Спробуйте лише за <strong>99 грн</strong> на тиждень — економте 50%!',
          is_discounted: true,
        },
        {
          type: 'monthly',
          name: 'Місячна',
          price: '249 грн',
          daily: '~8 грн/день',
          old_price: '600 грн',
          promo_text:
            'Отримайте місяць за <strong>249 грн</strong> — знижка 60%!',
          is_discounted: true,
        },
        {
          type: 'quarterly',
          name: 'Квартальна',
          price: '1 500 грн',
          daily: '~16 грн/день',
        },
        {
          type: 'semi_annual',
          name: 'Піврічна',
          price: '2 700 грн',
          daily: '~15 грн/день',
        },
        {
          type: 'annual',
          name: 'Річна',
          price: '4 800 грн',
          daily: '~13 грн/день',
        },
      ];
    }
  } else {
    plans = [
      {
        type: 'weekly',
        name: 'Тижнева',
        price: '150 грн',
        daily: '~21 грн/день',
      },
      {
        type: 'monthly',
        name: 'Місячна',
        price: '400 грн',
        daily: '~13 грн/день',
      },
      {
        type: 'quarterly',
        name: 'Квартальна',
        price: '1 000 грн',
        daily: '~11 грн/день',
      },
      {
        type: 'semi_annual',
        name: 'Піврічна',
        price: '1 800 грн',
        daily: '~10 грн/день',
      },
      {
        type: 'annual',
        name: 'Річна',
        price: '3 400 грн',
        daily: '~9 грн/день',
      },
    ];
  }

  let plansHtml = plans
    .map((plan) => {
      if (plan.is_discounted) {
        return `
                <div class="subscription-plan-card discount-card-bg">
                    <div class="discount-badge">ЗНИЖКА</div>
                    <h5 class="plan-name">${plan.name}</h5>
                    <div class="old-price">${plan.old_price}</div>
                    <div class="promo-text">${plan.promo_text}</div>
                    <div class="plan-daily-price">${plan.daily}</div>
                    <button class="pay-button" data-type="${plan.type}" data-plan-type="${planTypeForAPI}">Обрати</button>
                </div>
            `;
      } else {
        return `
                <div class="subscription-plan-card">
                    <h5 class="plan-name">${plan.name}</h5>
                    <div class="old-price"></div>
                    <div class="plan-price">${plan.price}</div>
                    <div class="plan-daily-price">${plan.daily}</div>
                    <button class="pay-button" data-type="${plan.type}" data-plan-type="${planTypeForAPI}">Обрати</button>
                </div>
            `;
      }
    })
    .join('');

  let agreementHTML = `
        <div class="payment-agreement">
            <label>
                <input type="checkbox" id="terms-agreement-checkbox">
                Я ознайомлений(а) та погоджуюсь з умовами 
                <a href="https://limaxsport.com/aferta" target="_blank">Публічної оферти</a> та 
                <a href="https://limaxsport.com/privacy-policy" target="_blank">Політики конфіденційності</a>.
            </label>
    `;

  // Показуємо чекбокс для ВСІХ користувачів, якщо це їхня перша оплата
  if (isFirstEverPayment) {
    agreementHTML += `
            <label style="margin-top: 10px;">
                <input type="checkbox" id="auto-renewal-agreement-checkbox">
                Я погоджуюсь на автоподовження підписки (можна вимкнути будь-коли у вкладці "Підписка").
            </label>
        `;
  }
  agreementHTML += '</div>';

  // --- НОВА ЛОГІКА ДЛЯ ПОЯСНЮВАЛЬНОГО ТЕКСТУ ---
  let introTextHTML = '';
  if (
    userData &&
    userData.registration_type === 'self' &&
    !hasPreviousPayment
  ) {
    introTextHTML = `<p class="payment-section-intro">Щоб отримати детальні тренування (із конкретними вправами, технікою виконання, показниками у вправах і багато іншого), відповідно до вашого персонального "Плану тренувань", будь ласка, активуйте підписку.</p>`;
  }
  // --- КІНЕЦЬ НОВОЇ ЛОГІКИ ---

  return `
        <div class="profile-section" id="payment-section">
            <h5 class="profile-section-title">${blockTitle}</h5>
            ${introTextHTML}
            <div class="subscription-plans-container">${plansHtml}</div>
            ${agreementHTML}
            <div id="payment-status-message" class="status-message"></div>
        </div>
    `;
}

/**
 * ОНОВЛЕНО v3: Гарантує послідовне виконання запитів для правильної активації автопоновлення.
 */
async function handlePayment(event) {
  const payButton = event.currentTarget;
  const subscriptionType = payButton.dataset.type;
  const planType = payButton.dataset.planType;
  const agreementCheckbox = document.getElementById('terms-agreement-checkbox');
  const autoRenewalCheckbox = document.getElementById(
    'auto-renewal-agreement-checkbox'
  );

  // 1. Перевірка згоди з умовами (залишається без змін)
  if (
    !agreementCheckbox ||
    !agreementCheckbox.checked ||
    (autoRenewalCheckbox && !autoRenewalCheckbox.checked)
  ) {
    const statusMessageElement = document.getElementById(
      'payment-status-message'
    );
    const agreementContainer = document.querySelector('.payment-agreement');
    let errorMessage =
      'Будь ласка, погодьтеся з умовами оферти та політики конфіденційності.';
    if (autoRenewalCheckbox && !autoRenewalCheckbox.checked) {
      errorMessage =
        'Будь ласка, підтвердіть вашу згоду з автоподовженням підписки.';
    }
    displayStatus(statusMessageElement.id, errorMessage, true, 5000);

    if (agreementContainer) {
      agreementContainer.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      agreementContainer.classList.add('highlight-error');
      setTimeout(() => {
        agreementContainer.classList.remove('highlight-error');
      }, 1500);
    }
    return;
  }

  payButton.disabled = true;
  payButton.textContent = 'Зачекайте...';
  displayStatus(
    'payment-status-message',
    `Готуємо оплату для підписки...`,
    false
  );

  try {
    // --- КРОК 1: АКТИВАЦІЯ АВТОПОНОВЛЕННЯ (ЯКЩО ПОТРІБНО) ---
    // Якщо чекбокс автопоновлення існує і він відмічений...
    if (autoRenewalCheckbox && autoRenewalCheckbox.checked) {
      displayStatus(
        'payment-status-message',
        'Активуємо автоподовження...',
        false
      );

      // ...ми відправляємо запит і ЧЕКАЄМО (await) на його завершення.
      const { response: autoRenewResponse, data: autoRenewData } =
        await fetchWithAuth(`${baseURL}/profile/auto-renew`, {
          method: 'PUT',
          body: JSON.stringify({ enabled: true }),
        });

      // Якщо не вдалося активувати, зупиняємо весь процес.
      if (!autoRenewResponse.ok) {
        throw new Error(
          autoRenewData.detail || 'Не вдалося налаштувати автоподовження.'
        );
      }

      // Оновлюємо кеш профілю
      if (currentUserProfileData) {
        currentUserProfileData.auto_renew_enabled = true;
      }
    }

    // --- КРОК 2: ІНІЦІАЦІЯ ПЛАТЕЖУ ---
    // Цей код виконається ТІЛЬКИ ПІСЛЯ того, як попередній запит (якщо він був) успішно завершився.
    displayStatus(
      'payment-status-message',
      'Перенаправляємо на сторінку оплати...',
      false
    );
    const { data: paymentData, response } = await fetchWithAuth(
      `${baseURL}/api/initiate-payment`,
      {
        method: 'POST',
        body: JSON.stringify({
          subscription_type: subscriptionType,
          plan_type: planType,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(
        paymentData.detail || `Помилка сервера: ${response.status}`
      );
    }

    // ... (решта коду для перенаправлення на LiqPay залишається без змін) ...
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = 'https://www.liqpay.ua/api/3/checkout';
    form.acceptCharset = 'utf-8';
    form.style.display = 'none';
    const dataInput = document.createElement('input');
    dataInput.type = 'hidden';
    dataInput.name = 'data';
    dataInput.value = paymentData.data;
    const signatureInput = document.createElement('input');
    signatureInput.type = 'hidden';
    signatureInput.name = 'signature';
    signatureInput.value = paymentData.signature;
    form.appendChild(dataInput);
    form.appendChild(signatureInput);
    document.body.appendChild(form);
    form.submit();
  } catch (error) {
    console.error('Помилка ініціації платежу:', error);
    displayStatus(
      'payment-status-message',
      `Помилка: ${error.message}`,
      true,
      10000
    );
    payButton.disabled = false;
    payButton.textContent = 'Обрати';
  }
}

async function loadSubscriptionData() {
  const container = document.getElementById('subscription');
  if (!container) return;
  container.innerHTML = '<p>Завантаження даних про підписку...</p>';

  try {
    if (!currentUserProfileData) {
      currentUserProfileData = await fetchCurrentProfileDataOnce();
    }
    const { data: subscriptions, response } = await fetchWithAuth(
      `${baseURL}/api/my-subscriptions`
    );
    if (!response.ok) {
      throw new Error(
        subscriptions.detail || `Помилка сервера: ${response.status}`
      );
    }

    displaySubscriptions(subscriptions || [], currentUserProfileData);
  } catch (error) {
    container.innerHTML = `<p style="color:red;">Не вдалося завантажити дані: ${error.message}</p>`;
  }
}

function displaySubscriptions(subscriptions, userData) {
  const container = document.getElementById('subscription');
  if (!container) return;

  let activeSubscription = null;

  const now = new Date(); // ВИПРАВЛЕНО: Визначаємо поточний час
  const allSubs = subscriptions || []; // ВИПРАВЛЕНО: Визначаємо allSubs з параметра функції

  // 1. Знаходимо ОДНУ дійсно активну підписку.
  // Сортуємо, щоб знайти ту, що закінчується найпізніше.
  activeSubscription = allSubs
    .filter((sub) => sub.status === 'active' && new Date(sub.end_date) > now)
    .sort((a, b) => new Date(b.end_date) - new Date(a.end_date))[0];

  // 2. Формуємо історію:
  // - Виключаємо активну підписку (якщо вона є).
  // - Виключаємо підписки, що очікують оплати.
  // - Сортуємо за датою початку (новіші перші).
  // - Беремо тільки перші 10 записів.
  const historyCandidates = allSubs.filter((sub) => {
    const isTheActiveOne =
      activeSubscription && sub.id === activeSubscription.id;
    const isPending = sub.status === 'pending_payment';
    return !isTheActiveOne && !isPending;
  });

  // Сортуємо за датою початку, щоб найновіші були першими
  historyCandidates.sort(
    (a, b) => new Date(b.start_date) - new Date(a.start_date)
  );

  // Обрізаємо історію до 10 записів
  const finalHistory = historyCandidates.slice(0, 10);

  let finalHtml = '';
  const isFirstPaymentScenario =
    !activeSubscription && userData && userData.registration_type === 'self';

  if (!isFirstPaymentScenario) {
    finalHtml += '<div class="profile-section">';
    finalHtml += '<h5 class="profile-section-title">Активна підписка</h5>';
    if (activeSubscription) {
      const endDate = new Date(activeSubscription.end_date).toLocaleDateString(
        'uk-UA',
        { day: '2-digit', month: '2-digit', year: 'numeric' }
      );
      finalHtml += `
                <div class="subscription-item-user status-active">
                    <div class="subscription-info-user">
                        <p><strong>Тип:</strong> ${translateField('subscription_type', activeSubscription.subscription_type)}</p>
                        <p><strong>План:</strong> ${activeSubscription.plan_type === 'without_trainer' ? 'Без тренера' : 'З тренером'}</p>
                        <p><strong>Стан:</strong> <span class="status-text-active">Активна</span></p>
                        <p><strong>Дійсна до:</strong> ${endDate}</p>
                    </div>
                </div>`;
    } else {
      finalHtml +=
        '<p class="empty-section-message">У вас немає активної підписки. Будь ласка, оберіть тариф нижче, щоб продовжити користування всіма перевагами кабінету.</p>';
    }
    finalHtml += '</div>';
  }

  finalHtml += generatePaymentBlockHTML(userData, subscriptions);

  if (activeSubscription) {
    const isAutoRenewEnabled = userData.auto_renew_enabled === true;
    finalHtml += `
            <div class="profile-section auto-renewal-section">
                <h5 class="profile-section-title">Керування підпискою</h5>
                <p class="form-hint">
                    1. <strong>Увімкнено:</strong> Оплата за наступний період буде списана автоматично в останній день дії поточної підписки.<br>
                    2. <strong>Вимкнено:</strong> Автоматичних списань не буде. Вам потрібно буде подовжити підписку вручну.
                </p>
                <div class="auto-renewal-toggle">
                    <label for="auto-renewal-switch">Автоматично подовжувати підписку</label>
                    <label class="switch">
                        <input type="checkbox" id="auto-renewal-switch" ${isAutoRenewEnabled ? 'checked' : ''}>
                        <span class="slider round"></span>
                    </label>
                </div>
                <div id="auto-renewal-status" class="status-message"></div>
            </div>
        `;
  }

  if (finalHistory.length > 0) {
    // Сортування вже не потрібне, ми зробили його раніше
    finalHtml += '<div class="profile-section">';
    finalHtml += '<h5 class="profile-section-title">Історія підписок</h5>';
    finalHtml += '<ul class="subscription-list-user">';
    finalHistory.forEach((sub) => {
      const startDate = new Date(sub.start_date).toLocaleDateString('uk-UA');
      const endDate = new Date(sub.end_date).toLocaleDateString('uk-UA');
      const statusTranslations = {
        expired: 'Закінчилась',
        cancelled: 'Скасована',
        failed: 'Не вдалася',
        pending_payment: 'Очікує оплати',
      };
      finalHtml += `
                <li class="subscription-item-user status-${sub.status}">
                    <div class="subscription-info-user">
                        <p><strong>Тип:</strong> ${translateField('subscription_type', sub.subscription_type)}</p>
                        <p><strong>План:</strong> ${sub.plan_type === 'without_trainer' ? 'Без тренера' : 'З тренером'}</p>
                        <p><strong>Період:</strong> ${startDate} - ${endDate}</p>
                        <p><strong>Стан:</strong> ${statusTranslations[sub.status] || sub.status}</p>
                    </div>
                </li>`;
    });
    finalHtml += '</ul></div>';
  }

  container.innerHTML = finalHtml;

  container.querySelectorAll('.pay-button').forEach((button) => {
    button.addEventListener('click', handlePayment);
  });

  const autoRenewalSwitch = container.querySelector('#auto-renewal-switch');
  if (autoRenewalSwitch) {
    autoRenewalSwitch.addEventListener('change', handleAutoRenewalToggle);
  }
}

/**
 * ОНОВЛЕНО v2: Виправлено URL для відповідності бекенду.
 */
async function handleAutoRenewalToggle(event) {
  const isEnabled = event.target.checked;
  const statusDivId = 'auto-renewal-status';
  displayStatus(statusDivId, 'Зберігаємо налаштування...', false);

  try {
    // ВИПРАВЛЕНО: Вказуємо правильний ендпоінт /profile/auto-renew
    const { data, response } = await fetchWithAuth(
      `${baseURL}/profile/auto-renew`,
      {
        method: 'PUT',
        body: JSON.stringify({ enabled: isEnabled }),
      }
    );

    if (!response.ok) {
      throw new Error(data.detail || 'Не вдалося змінити налаштування.');
    }

    displayStatus(statusDivId, data.message, false, 4000);

    if (currentUserProfileData) {
      currentUserProfileData.auto_renew_enabled = isEnabled;
    }
  } catch (error) {
    console.error('Помилка оновлення статусу автоподовження:', error);
    displayStatus(statusDivId, `Помилка: ${error.message}`, true, 5000);
    event.target.checked = !isEnabled;
  }
}

/**
 * ОНОВЛЕНО v3: Перевіряє наявність активної підписки через спеціалізований ендпоінт.
 * @param {boolean} forceRedirect - Чи потрібно примусово перенаправляти на вкладку "Підписка", якщо її немає.
 * @returns {Promise<boolean>} - Повертає true, якщо є активна підписка, інакше false.
 */
async function checkInitialSubscriptionAndRedirect(forceRedirect = true) {
  if (!isAuthorized()) {
    updateTabAccessibility(false, null); // Передаємо null, бо профіль невідомий
    return false;
  }

  let hasActiveSub = false;
  let userProfile = null; // Змінна для зберігання профілю

  try {
    // Завантажуємо і підписку, і профіль одночасно
    const [subResult, profileResult] = await Promise.all([
      fetchWithAuth(`${baseURL}/api/my-subscriptions`),
      fetchCurrentProfileDataOnce(), // Використовуємо кешовану функцію
    ]);

    const { data: subscriptions, response: subResponse } = subResult;
    userProfile = profileResult; // Зберігаємо профіль
    currentUserProfileData = userProfile; // Оновлюємо глобальний кеш

    if (subResponse.ok && Array.isArray(subscriptions)) {
      const now = new Date();
      hasActiveSub = subscriptions.some(
        (sub) => sub.status === 'active' && new Date(sub.end_date) > now
      );
    }
  } catch (error) {
    console.error(
      'Помилка під час перевірки підписки або профілю:',
      error.message
    );
    hasActiveSub = false;
  }

  // Оновлюємо доступність вкладок, передаючи ОБИДВА параметри
  updateTabAccessibility(hasActiveSub, userProfile);

  const isSelfUserOnPlanTab =
    userProfile?.registration_type === 'self' &&
    window.location.hash === '#plan';

  if (isSelfUserOnPlanTab) {
    // Якщо це новий користувач, який щойно потрапив на вкладку "План",
    // прокручуємо сторінку догори.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (forceRedirect && !hasActiveSub && !isSelfUserOnPlanTab) {
    // Тільки в інших випадках перенаправляємо на підписку
    const subscriptionTabButton = document.querySelector(
      '.tab-link[data-tab-name="subscription"]'
    );
    if (subscriptionTabButton) {
      openTab({ currentTarget: subscriptionTabButton }, 'subscription');
      // І прокручуємо догори при перенаправленні на "Підписку".
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  return hasActiveSub;
}
// КІНЕЦЬ вкладки "ПІДПИСКА"

// ==========================================================
// === НОВИЙ БЛОК: ЛОГІКА ДЛЯ ВКЛАДКИ "ПЛАН" ===
// ==========================================================

/**
 * Головна функція: завантажує згенеровані плани з API та запускає їх відображення.
 */
async function loadAndDisplayWorkoutPlans() {
  const container = document.getElementById('plan');
  if (!container) return;

  container.innerHTML = '<p>Завантаження вашого тренувального плану...</p>';

  try {
    // Просто запитуємо плани. Інформація про підписку тут більше не потрібна.
    const { data: plans, response } = await fetchWithAuth(
      `${baseURL}/my-workout-plans`
    );

    if (!response.ok) {
      throw new Error(plans.detail || `Помилка сервера: ${response.status}`);
    }

    // Передаємо тільки плани, як і раніше
    renderWorkoutPlans(plans);
  } catch (error) {
    console.error('Помилка завантаження тренувальних планів:', error);
    container.innerHTML = `<p style="color:red;">Не вдалося завантажити плани: ${error.message}</p>`;
  }
}

/**
 * Аналізує назву тренування і повертає відповідний CSS-клас для стилізації.
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

/**
 * ВЕРСІЯ 2.0: Відображає плани у вигляді сучасних під-вкладок з табличним розкладом.
 * @param {Array} plans - Масив об'єктів планів з API.
 */
function renderWorkoutPlans(plans, hasActiveSubscription) {
  const container = document.getElementById('plan');
  if (!container) return;

  if (!plans || plans.length === 0) {
    container.innerHTML = `<div class="profile-section"><p class="empty-section-message">Для вас ще не згенеровано жодного тренувального плану. План генерується автоматично після реєстрації.</p></div>`;
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

    subTabsHtml += `<button class="sub-tab-link ${isActive ? 'active' : ''}" onclick="openPlanSubTab(event, 'plan-content-${plan.id}')" data-plan-id="${plan.id}">${tabButtonText}</button>`;

    let actionBlockHtml = '';
    if (!plan.are_workouts_generated) {
      // --- ОСНОВНА ЗМІНА ТУТ: Новий HTML для блоку кнопок ---
      actionBlockHtml = `
                <div class="plan-actions">
                    <p class="plan-actions-header">Щоб отримати детальні тренування (із конкретними вправами, технікою виконання, показниками у вправах і багато іншого), відповідно до цього "Плану тренувань", будь ласка, активуйте підписку.</p>
                    <button class="main-action-button green-btn" onclick="handleGenerateWorkoutsClick(${plan.id})">Перейти до активації підписки</button>
            `;
      if (!plan.has_been_edited) {
        actionBlockHtml += `
                    <p class="plan-actions-subheader">За бажанням, ви можете внести правки в План тренувань (доступно 1 раз).</p>
                    <button class="secondary-action-button" onclick="handleEditPlanClick(${plan.id})">Редагувати план</button>
                `;
      }
      actionBlockHtml += `<div id="edit-plan-container-${plan.id}" style="display:none;"></div></div>`;
    }

    subContentsHtml += `
            <div id="plan-content-${plan.id}" class="plan-sub-content" style="display: ${isActive ? 'block' : 'none'};">
                <h4 class="profile-sub-content-title">${plan.plan_title || 'Тренувальний план'}</h4>
                <div class="plan-intro-text"><p>${formatTextWithLineBreaks(plan.introductory_text) || 'Загальний опис відсутній.'}</p></div>
                
                ${
                  plan.workouts && plan.workouts.length > 0
                    ? `
                    <div class="plan-schedule">
                        <h5 class="profile-section-title">Розклад тренувань</h5>
                        <div class="table-scroll-wrapper">
                            <table class="plan-schedule-table">
                                <!-- ЗМІНА ТУТ: Спрощуємо заголовок таблиці -->
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
                
                ${actionBlockHtml}
            </div>
        `;
  });

  subTabsHtml += '</div>';
  container.innerHTML = subTabsHtml + subContentsHtml;
}

/**
 * ОНОВЛЕНО: Перенаправляє користувача на вкладку підписки та прокручує до верху.
 */
function handleGenerateWorkoutsClick(planId) {
  // Знаходимо кнопку вкладки "Підписка" і імітуємо клік
  const subscriptionTabButton = document.querySelector(
    '.tab-link[data-tab-name="subscription"]'
  );
  if (subscriptionTabButton) {
    openTab({ currentTarget: subscriptionTabButton }, 'subscription');

    // Прокручуємо до верхньої частини вкладки "Підписка"
    setTimeout(() => {
      // Знаходимо головний контейнер вкладки "Підписка"
      const subscriptionTabContent = document.getElementById('subscription');
      if (subscriptionTabContent) {
        // Прокручуємо до початку цього контейнера
        subscriptionTabContent.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }
    }, 300); // Невелика затримка, щоб вкладка встигла відобразитись
  }
}

/**
 * Показує поле для введення правок до плану.
 */
function handleEditPlanClick(planId) {
  const container = document.getElementById(`edit-plan-container-${planId}`);
  if (!container) return;

  container.style.display = 'block';
  container.innerHTML = `
        <div class="edit-plan-form">
            <label for="plan-feedback-input-${planId}">Опишіть ваші побажання або правки до плану:</label>
            <textarea id="plan-feedback-input-${planId}" rows="4" placeholder="Наприклад: 'Додайте більше вправ на ноги' або 'Зробіть план менш інтенсивним'"></textarea>
            <button class="main-action-button" onclick="submitPlanEdit(${planId})">Відправити правки</button>
            <div id="edit-plan-status-${planId}" class="status-message"></div>
        </div>
    `;
}

/**
 * Відправляє правки користувача на сервер для регенерації плану.
 */
async function submitPlanEdit(planId) {
  const feedbackInput = document.getElementById(
    `plan-feedback-input-${planId}`
  );
  const statusDiv = document.getElementById(`edit-plan-status-${planId}`);
  const formContainer = document.getElementById(
    `edit-plan-container-${planId}`
  );
  const submitBtn = formContainer.querySelector('.main-action-button');
  const feedbackText = feedbackInput.value.trim();

  if (feedbackText.length < 10) {
    displayStatus(
      statusDiv.id,
      'Будь ласка, опишіть ваші побажання більш детально (мінімум 10 символів).',
      true,
      3000
    );
    return;
  }

  // --- 1. Блокуємо UI та показуємо стан завантаження ---
  submitBtn.disabled = true;
  submitBtn.innerHTML = 'Відправляємо...'; // Змінюємо текст кнопки

  const loader = document.createElement('div');
  loader.className = 'plan-edit-loader';
  submitBtn.appendChild(loader); // Вставляємо анімацію всередину кнопки

  submitBtn.classList.add('button-loading'); // Додаємо клас для вирівнювання

  displayStatus(
    statusDiv.id,
    'Відправляємо ваші правки та генеруємо новий план... Це може зайняти до 1 хвилини.',
    false
  );

  try {
    const { data: newPlan, response } = await fetchWithAuth(
      `${baseURL}/edit-workout-plan/${planId}`,
      {
        method: 'POST',
        body: JSON.stringify({ user_feedback: feedbackText }),
      }
    );

    if (!response.ok) {
      throw new Error(newPlan.detail || 'Не вдалося оновити план.');
    }

    displayStatus(
      statusDiv.id,
      'Новий план успішно згенеровано! Оновлюємо...',
      false
    );

    // Після успіху вся вкладка буде перемальована, тому вручну прибирати анімацію не потрібно.
    setTimeout(() => {
      loadAndDisplayWorkoutPlans();
    }, 2000);
  } catch (error) {
    console.error('Помилка редагування плану:', error);
    displayStatus(statusDiv.id, `Помилка: ${error.message}`, true, 5000);

    // --- 2. Повертаємо кнопку до початкового стану ТІЛЬКИ у випадку помилки ---
    submitBtn.disabled = false;
    const loaderEl = submitBtn.querySelector('.plan-edit-loader');
    if (loaderEl) {
      loaderEl.remove();
    }
    submitBtn.textContent = 'Відправити правки'; // Повертаємо оригінальний текст
    submitBtn.classList.remove('button-loading');
  }
}

/**
 * Перемикає видимість під-вкладок у розділі "План".
 * @param {Event} event - Подія кліку.
 * @param {string} subTabContentId - ID контенту, який треба показати.
 */
function openPlanSubTab(event, subTabContentId) {
  const planContainer = document.getElementById('plan');
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
 * Перевіряє тип реєстрації користувача та показує або ховає вкладку "План".
 */
async function updatePlanTabVisibility() {
  const planTabButton = document.querySelector(
    '.tab-link[data-tab-name="plan"]'
  );
  if (!planTabButton) {
    console.warn('Кнопка вкладки "План" не знайдена.');
    return;
  }

  try {
    // Переконуємось, що дані профілю завантажені.
    // Використовуємо кешовані дані, якщо вони є.
    if (!currentUserProfileData) {
      currentUserProfileData = await fetchCurrentProfileDataOnce();
    }

    // Перевіряємо тип реєстрації та показуємо/ховаємо вкладку
    if (
      currentUserProfileData &&
      currentUserProfileData.registration_type === 'self'
    ) {
      planTabButton.style.display = 'inline-block'; // Показуємо вкладку
    } else {
      planTabButton.style.display = 'none'; // Ховаємо вкладку для всіх інших
    }
  } catch (error) {
    console.error("Помилка при визначенні видимості вкладки 'План':", error);
    planTabButton.style.display = 'none'; // Ховаємо вкладку у разі помилки
  }
}

// ==========================================================
// === КІНЕЦЬ НОВОГО БЛОКУ ДЛЯ ВКЛАДКИ "ПЛАН" ===
// ==========================================================

// --- Логіка для Профілю - Виключені вправи (СЕКЦІЯ РЕДАГУВАННЯ) ---

// Важливо: перейменовуємо або робимо функції параметризованими, якщо виключені вправи
// будуть показуватись і в "Мій профіль" (не як чекбокси, а як список).
// Поки що, припускаємо, що чекбокси ТІЛЬКИ в секції редагування.

function initializeExcludedExercisesToggleForEditForm() {
  const toggleButton = document.getElementById(
    'toggleExcludedExercisesBtn_edit'
  ); // ID кнопки в формі редагування
  const checklistContainer = document.getElementById(
    'excludedExercisesChecklistContainer_edit'
  ); // ID контейнера в формі

  if (toggleButton && checklistContainer) {
    if (toggleButton.dataset.listenerAttached === 'true') return;
    toggleButton.dataset.listenerAttached = 'true';

    // Логіка згортання/розгортання (як у вас було)
    if (window.innerWidth < 768) {
      checklistContainer.classList.remove('expanded');
      toggleButton.classList.remove('active');
    } else {
      checklistContainer.classList.remove('expanded'); // За замовчуванням згорнуто
      toggleButton.classList.remove('active');
    }

    toggleButton.addEventListener('click', () => {
      toggleButton.classList.toggle('active');
      checklistContainer.classList.toggle('expanded');
    });
  } else {
    console.warn(
      'Кнопка або контейнер для виключених вправ у формі редагування не знайдені.'
    );
  }
}

async function loadAndRenderExcludedExercisesForEditForm() {
  const checklistContainer = document.getElementById(
    'excludedExercisesChecklistContainer_edit'
  );
  const statusElementId = 'profile-update-status_edit';

  if (!checklistContainer) {
    console.warn(
      'Контейнер для виключених вправ у формі редагування не знайдено.'
    );
    return;
  }

  if (!isAuthorized()) {
    checklistContainer.innerHTML = '<p>Будь ласка, увійдіть в систему.</p>';
    return;
  }

  checklistContainer.innerHTML =
    '<p>Завантаження доступних вправ для виключення...</p>';

  try {
    // Отримуємо доступні для виключення GIF
    const { data: availableGifObjects, response: availableResponse } =
      await fetchWithAuth(`${baseURL}/profile/excluded-exercises/available`);
    if (!availableResponse.ok) {
      // У data може бути детальна помилка
      throw new Error(
        availableGifObjects?.detail ||
          `Помилка завантаження доступних GIF: ${availableResponse.status}`
      );
    }

    const availableGifNames = availableGifObjects
      .map((gif) => gif.name)
      .filter((name) => name && name.trim() !== '');

    // Отримуємо вже виключені користувачем GIF
    const { data: userExcludedGifNames, response: userExcludedResponse } =
      await fetchWithAuth(`${baseURL}/profile/excluded-exercises`);
    if (!userExcludedResponse.ok) {
      throw new Error(
        userExcludedGifNames?.detail ||
          `Помилка завантаження виключених GIF: ${userExcludedResponse.status}`
      );
    }

    renderExcludedExercisesChecklistInEditForm(
      availableGifNames,
      userExcludedGifNames,
      checklistContainer,
      statusElementId
    );
  } catch (error) {
    console.error(
      'Помилка завантаження даних для виключених вправ (форма редагування):',
      error
    );
    checklistContainer.innerHTML = `<p style="color: red;">Не вдалося завантажити список: ${error.message}.</p>`;
  }
}

function renderExcludedExercisesChecklistInEditForm(
  availableNames,
  userExcludedNames,
  container,
  statusId
) {
  container.innerHTML = ''; // Очищуємо контейнер

  if (!availableNames || availableNames.length === 0) {
    container.innerHTML =
      '<p>Ваш тренер ще не додав вправ, які можна було б виключити.</p>';
    return;
  }

  // <<< НОВЕ: Сортування списку вправ >>>
  const sortedAvailableNames = [...availableNames].sort((a, b) => {
    const isAExcluded = userExcludedNames.includes(a);
    const isBExcluded = userExcludedNames.includes(b);

    // 1. Спочатку порівнюємо за статусом "виключено"
    // Якщо 'a' виключено, а 'b' ні, то 'a' має бути вище (-1)
    if (isAExcluded && !isBExcluded) {
      return -1;
    }
    // Якщо 'b' виключено, а 'a' ні, то 'b' має бути вище (1)
    if (!isAExcluded && isBExcluded) {
      return 1;
    }

    // 2. Якщо статус однаковий (обидві виключені або обидві ні), сортуємо за алфавітом
    return a.localeCompare(b);
  });
  // <<< КІНЕЦЬ НОВОГО БЛОКУ СОРТУВАННЯ >>>

  // Створюємо поле пошуку
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Пошук вправи... 🔍';
  searchInput.className = 'excluded-exercise-search-input';
  container.appendChild(searchInput);

  // Створюємо контейнер для самого списку
  const listWrapper = document.createElement('div');
  listWrapper.className = 'excluded-exercise-list-wrapper';
  container.appendChild(listWrapper);

  sortedAvailableNames.forEach((gifName, index) => {
    // Створюємо ID на основі унікального індексу
    const checkboxId = `exclude-gif-edit-${index}`;

    const label = document.createElement('label');
    label.className = 'excluded-exercise-option';
    // <<< НОВЕ: Додаємо клас, якщо вправа виключена, для можливої стилізації >>>
    if (userExcludedNames.includes(gifName)) {
      label.classList.add('is-excluded');
    }
    // <<< КІНЕЦЬ ЗМІНИ >>>
    label.setAttribute('for', checkboxId);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = checkboxId;
    checkbox.value = gifName;
    checkbox.checked = userExcludedNames.includes(gifName);

    checkbox.addEventListener('change', async (event) => {
      const name = event.target.value;
      const isChecked = event.target.checked;

      displayStatus(statusId, `Обробка "${name}"...`, false);

      try {
        let endpointMethod = isChecked ? 'POST' : 'DELETE';
        await fetchWithAuth(`${baseURL}/profile/excluded-exercises`, {
          method: endpointMethod,
          body: JSON.stringify({ gif_name: name }),
        });
        displayStatus(
          statusId,
          `Налаштування для "${name}" ${isChecked ? 'додано' : 'видалено'}.`,
          false,
          3000
        );

        // Оновлюємо клас для візуального відображення без перезавантаження
        label.classList.toggle('is-excluded', isChecked);
      } catch (error) {
        displayStatus(
          statusId,
          `Помилка для "${name}": ${error.message}`,
          true,
          5000
        );
        event.target.checked = !isChecked;
      }
    });

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` ${gifName}`));
    listWrapper.appendChild(label);
  });

  // Логіка фільтрації (залишається без змін)
  searchInput.addEventListener('input', (event) => {
    const searchTerm = event.target.value.toLowerCase();
    const allLabels = listWrapper.querySelectorAll('.excluded-exercise-option');

    allLabels.forEach((label) => {
      const exerciseName = label.textContent.toLowerCase();
      if (exerciseName.includes(searchTerm)) {
        label.style.display = '';
      } else {
        label.style.display = 'none';
      }
    });
  });
}
// --- Кінець логіки для Профілю --- виключені вправи

/**
 * Завантажує дані профілю користувача з сервера.
 * @returns {Promise<Object|null>} Об'єкт з даними профілю або null у разі помилки 404.
 * @throws {Error} У разі інших помилок сервера.
 */
async function fetchCurrentProfileDataOnce() {
  //console.log("Запит даних профілю з сервера...");
  try {
    const { data, response } = await fetchWithAuth(
      `${baseURL}/profile/my-profile`
    );
    if (response.status === 404) {
      //console.log("Профіль не знайдено на сервері (404).");
      return null; // Профіль ще не створено
    }
    if (!response.ok) {
      // Просто використовуємо 'data', де вже є розпарсена помилка з fetchWithAuth
      throw new Error(
        data?.detail || `Помилка завантаження профілю: ${response.status}`
      );
    }

    //console.log("Дані профілю отримано:", data);
    return data;
  } catch (error) {
    console.error('fetchCurrentProfileDataOnce: Помилка:', error);
    throw error; // Прокидаємо помилку далі
  }
}

/**
 * Повертає український текст для статі.
 * @param {string} genderValue - Значення з бекенду ('male', 'female', 'not_applicable').
 * @returns {string} Перекладений текст.
 */
function getGenderText(genderValue) {
  const translations = {
    male: 'Чоловіча',
    female: 'Жіноча',
    not_applicable: 'Не застосовується',
  };
  return translations[genderValue] || 'Не вказано';
}

/**
 * Відображає дані профілю користувача в секції "Мій профіль".
 * @param {Object|null} userData - Дані профілю користувача (UserProfileOut з бекенду).
 * // @param {HTMLElement} container - Цей параметр більше не потрібен, якщо ми завжди працюємо з #profile-view-data
 */
function displayUserProfileViewData(userData) {
  const profileViewDataContainer = document.getElementById('profile-view-data'); // Основний контейнер для контенту "Мій профіль"
  const emptyMessageContainer = document.getElementById(
    'profile-view-empty-message'
  );

  if (!profileViewDataContainer || !emptyMessageContainer) {
    console.error(
      'Не знайдено DOM елементи #profile-view-data або #profile-view-empty-message.'
    );
    return;
  }

  if (!userData) {
    profileViewDataContainer.innerHTML = ''; // Очищаємо, якщо там було повідомлення про завантаження
    emptyMessageContainer.style.display = 'block';
    // Скрол до верху, навіть якщо профіль порожній
    const profileViewSubTabToScroll = document.getElementById('profile-view');
    if (profileViewSubTabToScroll) {
      profileViewSubTabToScroll.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }
    return;
  }

  emptyMessageContainer.style.display = 'none';
  profileViewDataContainer.innerHTML = ''; // Очищуємо перед заповненням

  // --- Підготовка даних для відображення (допоміжні змінні) ---
  let registrantHtml = 'Не вказано';
  if (userData.who_registered) {
    registrantHtml = `${userData.who_registered.full_name || "Ім'я не вказано"}`;
    if (userData.who_registered.phone) {
      registrantHtml += ` (<a href="tel:${userData.who_registered.phone}" class="link-subtle">${userData.who_registered.phone}</a>)`;
    }
  }

  let suspensionNoticeHtml = ''; // Перейменовано для ясності
  if (userData.is_suspended) {
    suspensionNoticeHtml = `<div class="profile-section profile-suspension-notice">
                            <p><strong>Статус вашого облікового запису:</strong> Призупинено 
                            ${userData.suspension_date ? ` (з ${new Date(userData.suspension_date).toLocaleDateString('uk-UA')})` : ''}
                            </p>
                          </div>`;
  }

  // --- Блок 1: Загальна інформація профілю ---
  let generalInfoHtml =
    '<div class="profile-section profile-general-info-block">';
  generalInfoHtml += `<h5 class="profile-section-title">Загальна інформація</h5>`;
  generalInfoHtml += '<div class="profile-view-grid">';
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Повне ім\'я:</span> <span class="profile-view-value">${userData.full_name || 'Не вказано'}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Публічне ім\'я:</span> <span class="profile-view-value">${userData.display_name || 'Не вказано'}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Email:</span> <span class="profile-view-value">${userData.email || 'Не вказано'}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Вік:</span> <span class="profile-view-value">${userData.age || 'Не вказано'}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Стать:</span> <span class="profile-view-value">${getGenderText(userData.gender)}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Вага (кг):</span> <span class="profile-view-value">${userData.weight || 'Не вказано'}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Зріст (см):</span> <span class="profile-view-value">${userData.height || 'Не вказано'}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Ціль:</span> <span class="profile-view-value">${getGoalText(userData.goal)}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Щоденна активність:</span> <span class="profile-view-value">${getActivityText(userData.daytime_activity)}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Вид тренувань:</span> <span class="profile-view-value">${getTrainingTypeText(userData.type_of_training)}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Рівень підготовки:</span> <span class="profile-view-value">${getTrainingLevelText(userData.level_of_training)}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Тренувань на тиждень:</span> <span class="profile-view-value">${getTrainingDaysText(userData.training_days_per_week)}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item profile-view-item-full-width"><span class="profile-view-label">Бажані дні тренувань:</span> <span class="profile-view-value">${getWeekdaysText(userData.preferred_training_weekdays)}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item profile-view-item-full-width"><span class="profile-view-label">Проблеми зі здоров\'ям:</span> <span class="profile-view-value">${getHealthProblemsText(userData.health_problems) || 'Немає'}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item profile-view-item-full-width"><span class="profile-view-label">Інші проблеми:</span> <span class="profile-view-value">${userData.other_health_problems || 'Немає'}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item profile-view-item-full-width"><span class="profile-view-label">Виключені продукти:</span> <span class="profile-view-value">${getProductsText(userData.excluded_products) || 'Немає'}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item profile-view-item-full-width"><span class="profile-view-label">Інші виключені продукти:</span> <span class="profile-view-value">${userData.other_excluded_products || 'Немає'}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Кількість прийомів їжі:</span> <span class="profile-view-value">${getNumberOfMealsText(userData.number_of_meals)}</span></div>`;
  let excludedExercisesText = 'Немає';
  if (userData.excluded_exercises && userData.excluded_exercises.length > 0) {
    excludedExercisesText = userData.excluded_exercises.join(', ');
  }
  generalInfoHtml += `<div class="profile-view-item profile-view-item-full-width"><span class="profile-view-label">Виключені вправи (назви):</span> <span class="profile-view-value">${excludedExercisesText}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Дата реєстрації:</span> <span class="profile-view-value">${userData.registration_date ? new Date(userData.registration_date).toLocaleDateString('uk-UA') : 'Не вказано'}</span></div>`;

  // --- ОНОВЛЕНА ЛОГІКА ДЛЯ ТРЕНЕРА (для "Мій профіль") ---
  if (userData.is_trainer) {
    generalInfoHtml += `<div class="profile-view-item profile-view-item-full-width"><span class="profile-trainer-badge">ВИ ТРЕНЕР</span></div>`;
  } else if (userData.registration_type === 'self') {
    generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Статус:</span> <span class="profile-view-value">Користувач без тренера</span></div>`;
  } else {
    // Сюди потраплять всі, хто 'by_trainer'
    generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Ваш тренер:</span> <span class="profile-view-value">${registrantHtml}</span></div>`;
  }
  // Додаємо Instagram та Telegram
  if (userData.instagram_link) {
    let instaLink = userData.instagram_link;
    if (!instaLink.startsWith('http') && !instaLink.includes('instagram.com')) {
      instaLink = `https://www.instagram.com/${instaLink.replace('@', '')}`;
    }
    generalInfoHtml += `<div class="profile-view-item profile-view-item-full-width"><span class="profile-view-label">Instagram:</span> <span class="profile-view-value"><a href="${instaLink}" target="_blank" rel="noopener noreferrer" class="social-link">${userData.instagram_link}</a></span></div>`;
  } else {
    generalInfoHtml += `<div class="profile-view-item profile-view-item-full-width"><span class="profile-view-label">Instagram:</span> <span class="profile-view-value">Не вказано</span></div>`;
  }
  if (userData.telegram_link) {
    let tgLink = userData.telegram_link;
    if (!tgLink.startsWith('http') && !tgLink.includes('t.me/')) {
      tgLink = `https://t.me/${tgLink.replace('@', '').replace('https://t.me/', '')}`;
    }
    generalInfoHtml += `<div class="profile-view-item profile-view-item-full-width"><span class="profile-view-label">Telegram:</span> <span class="profile-view-value"><a href="${tgLink}" target="_blank" rel="noopener noreferrer" class="social-link">${userData.telegram_link}</a></span></div>`;
  } else {
    generalInfoHtml += `<div class="profile-view-item profile-view-item-full-width"><span class="profile-view-label">Telegram:</span> <span class="profile-view-value">Не вказано</span></div>`;
  }
  generalInfoHtml += '</div></div>'; // Кінець .profile-view-grid та .profile-general-info-block

  // --- Блок "Моя активність" (статистика) ---
  let statsHtml = '<div class="profile-section profile-stats-block">';
  statsHtml += `<h5 class="profile-section-title">Моя активність та визнання</h5>`;
  statsHtml += '<div class="stats-grid stats-grid-extended">';
  statsHtml += `<div class="stat-item"><span class="stat-icon">📅</span><span class="stat-value">${userData.active_days_on_platform !== null ? userData.active_days_on_platform : '0'}</span><span class="stat-label">Активних днів</span></div>`;
  statsHtml += `<div class="stat-item"><span class="stat-icon">🏆</span><span class="stat-value">${userData.completed_trainings_count !== null ? userData.completed_trainings_count : '0'}</span><span class="stat-label">Виконано тренувань</span></div>`;
  statsHtml += `<div class="stat-item"><span class="stat-icon">⚠️</span><span class="stat-value">${userData.missed_trainings_count !== null ? userData.missed_trainings_count : '0'}</span><span class="stat-label">Пропущено тренувань</span></div>`;
  statsHtml += `<div class="stat-item"><span class="stat-icon">❤️</span><span class="stat-value">${userData.total_likes_received !== null ? userData.total_likes_received : '0'}</span><span class="stat-label">Лайків профілю</span></div>`;
  statsHtml += '</div></div>';

  // --- Блок "Збережені показники у вправах" (Карусель) ---
  let preferencesHtml =
    '<div class="profile-section exercise-preferences-section">';
  preferencesHtml += `<h5 class="profile-section-title">Мої збережені показники</h5>`;

  if (
    userData.exercise_preferences_summary &&
    userData.exercise_preferences_summary.length > 0
  ) {
    preferencesHtml += `
            <div class="preferences-carousel-container my-profile-preferences-carousel"> 
                <div class="preferences-carousel-viewport">
                    <div class="preferences-carousel-track">`; // Початок треку зі слайдами

    userData.exercise_preferences_summary.forEach((pref) => {
      if (pref.gif_name) {
        preferencesHtml += `<div class="exercise-preference-item">`;
        preferencesHtml += `<h6>${pref.gif_name}</h6>`;
        preferencesHtml += generatePublicPreferenceTableHTML(pref);
        preferencesHtml += `</div>`;
      }
    });
    preferencesHtml += `
                    </div> </div> <div class="carousel-navigation-wrapper"> 
                    <button class="carousel-arrow prev" aria-label="Попередні" onclick="scrollPreferencesCarousel(this, -1)">&#10094;</button>
                    <button class="carousel-arrow next" aria-label="Наступні" onclick="scrollPreferencesCarousel(this, 1)">&#10095;</button>
                </div>
                </div> `;
  } else {
    preferencesHtml += `<p class="empty-section-message">Збережені показники у вправах відсутні.</p>`;
  }
  preferencesHtml += '</div>'; // Кінець .profile-section для переваг

  // Збираємо весь HTML для контейнера #profile-view-data
  profileViewDataContainer.innerHTML = `
        ${generalInfoHtml}
        ${statsHtml}
        ${suspensionNoticeHtml} 
        ${preferencesHtml}
    `;

  // Скрол до верху після оновлення контенту
  const profileViewSubTabToScroll = document.getElementById('profile-view');
  if (profileViewSubTabToScroll) {
    profileViewSubTabToScroll.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }
}

/**
 * Заповнює форму редагування профілю даними користувача.
 * @param {Object|null} userData - Дані профілю користувача.
 */
function populateProfileEditForm(userData) {
  const statusDiv = document.getElementById('profile-update-status_edit');

  // Заповнюємо поля форми - використовуємо ID з суфіксом _edit
  const fullNameInput = document.getElementById('full_name_edit');
  const displayNameInput = document.getElementById('display_name_edit');
  const emailInput = document.getElementById('email_edit');
  const instagramInput = document.getElementById('instagram_link_edit');
  const telegramInput = document.getElementById('telegram_link_edit');
  // ... і так далі для всіх полів форми, як у твоїй функції loadProfileData, але з ID _edit

  if (userData) {
    // Якщо є дані для заповнення
    if (statusDiv)
      displayStatus(
        statusDiv.id,
        'Дані завантажено для редагування.',
        false,
        3000
      );

    if (fullNameInput) fullNameInput.value = userData.full_name || '';
    if (displayNameInput) displayNameInput.value = userData.display_name || '';
    if (emailInput) emailInput.value = userData.email || '';
    if (instagramInput) instagramInput.value = userData.instagram_link || '';
    if (telegramInput) telegramInput.value = userData.telegram_link || '';
    // ... (заповнення решти полів) ...
    const ageInput = document.getElementById('age_edit');
    const genderSelect = document.getElementById('gender_edit');
    const weightInput = document.getElementById('weight_edit');
    const heightInput = document.getElementById('height_edit');
    const goalSelect = document.getElementById('goal_edit');
    const activitySelect = document.getElementById('daytime_activity_edit');
    const trainingTypeSelect = document.getElementById('type_of_training_edit');
    const trainingLevelSelect = document.getElementById(
      'level_of_training_edit'
    );
    const healthProblemsSelect = document.getElementById(
      'health_problems_edit'
    );
    const otherHealthTextarea = document.getElementById(
      'other_health_problems_edit'
    );
    const excludedProductsSelect = document.getElementById(
      'excluded_products_edit'
    );
    const otherExcludedProductsTextarea = document.getElementById(
      'other_excluded_products_edit'
    );
    const mealsSelect = document.getElementById('number_of_meals_edit');
    const trainingDaysSelect = document.getElementById(
      'training_days_per_week_edit'
    );
    const weekdayCheckboxesContainer = document.getElementById(
      'preferred_training_weekdays_edit_container'
    );

    if (ageInput) ageInput.value = userData.age || '';
    if (genderSelect) genderSelect.value = userData.gender || '';
    if (weightInput) weightInput.value = userData.weight || '';
    if (heightInput) heightInput.value = userData.height || '';
    if (goalSelect) goalSelect.value = userData.goal || '';
    if (activitySelect) activitySelect.value = userData.daytime_activity || '';
    if (trainingTypeSelect)
      trainingTypeSelect.value = userData.type_of_training || '';
    if (trainingLevelSelect)
      trainingLevelSelect.value = userData.level_of_training || '';

    const healthProblems = userData.health_problems || [];
    if (healthProblemsSelect) {
      Array.from(healthProblemsSelect.options).forEach((option) => {
        option.selected = healthProblems.includes(option.value);
      });
    }

    const excludedProducts = userData.excluded_products || [];
    if (excludedProductsSelect) {
      Array.from(excludedProductsSelect.options).forEach((option) => {
        option.selected = excludedProducts.includes(option.value);
      });
    }

    if (otherHealthTextarea) {
      otherHealthTextarea.value = userData.other_health_problems || '';
      if (typeof autoResize === 'function') autoResize(otherHealthTextarea);
    }
    if (otherExcludedProductsTextarea) {
      otherExcludedProductsTextarea.value =
        userData.other_excluded_products || '';
      if (typeof autoResize === 'function')
        autoResize(otherExcludedProductsTextarea);
    }
    if (mealsSelect) mealsSelect.value = userData.number_of_meals || '';

    if (trainingDaysSelect)
      trainingDaysSelect.value = userData.training_days_per_week || '';

    const preferredWeekdays = userData.preferred_training_weekdays || [];
    if (weekdayCheckboxesContainer) {
      const weekdayCheckboxes = weekdayCheckboxesContainer.querySelectorAll(
        'input[type="checkbox"]'
      );
      weekdayCheckboxes.forEach((checkbox) => {
        checkbox.checked = preferredWeekdays.includes(checkbox.value);
      });
    }
  } else {
    // Якщо userData null (профіль не існує)
    if (statusDiv)
      displayStatus(
        statusDiv.id,
        'Профіль ще не створено. Заповніть дані.',
        false
      );
    // Очистити форму, якщо потрібно, або залишити порожньою
    if (fullNameInput) fullNameInput.value = '';
    if (displayNameInput) displayNameInput.value = '';
    if (instagramInput) instagramInput.value = '';
    if (telegramInput) telegramInput.value = '';
    // ... (очищення решти полів) ...
  }

  // Завантажуємо та рендеримо список виключених вправ (чекбокси) для форми редагування
  loadAndRenderExcludedExercisesForEditForm(); // Потрібно створити або адаптувати
  initializeExcludedExercisesToggleForEditForm(); // Потрібно створити або адаптувати
  initializeWeekdaySelectorLogic();
  initializeWeekdaysToggleForEditForm();
  initializePasswordChangeForm();
}

/**
 * Головні функції для завантаження даних в залежності від активної під-вкладки.
 */
async function loadAndDisplayUserProfileViewData() {
  const statusDiv = document.getElementById('profile-update-status_edit'); // Можна використовувати загальний статус
  if (statusDiv)
    displayStatus(statusDiv.id, 'Завантаження даних профілю...', false);
  try {
    const profileData = await fetchCurrentProfileDataOnce();
    displayUserProfileViewData(profileData); // profileData може бути null
  } catch (error) {
    if (statusDiv)
      displayStatus(statusDiv.id, `Помилка: ${error.message}`, true);
    const emptyMessage = document.getElementById('profile-view-empty-message');
    const profileViewDataContainer =
      document.getElementById('profile-view-data');
    if (profileViewDataContainer) profileViewDataContainer.innerHTML = '';
    if (emptyMessage) {
      emptyMessage.innerHTML = `<p>Не вдалося завантажити дані профілю. Спробуйте пізніше.</p><p style="color:red; font-size:0.8em;">${error.message}</p>`;
      emptyMessage.style.display = 'block';
    }
  }
}

async function loadProfileDataForEditForm() {
  const statusDiv = document.getElementById('profile-update-status_edit');
  if (statusDiv)
    displayStatus(statusDiv.id, 'Завантаження даних для редагування...', false);
  try {
    const profileData = await fetchCurrentProfileDataOnce();
    populateProfileEditForm(profileData); // profileData може бути null
  } catch (error) {
    if (statusDiv)
      displayStatus(statusDiv.id, `Помилка: ${error.message}`, true);
    // Можна також очистити форму або показати повідомлення в самій формі
  }
}

// Оновлення профілю
const updateProfileMainButton = document.getElementById(
  'update-profile-main-btn'
); // НОВИЙ ID
if (updateProfileMainButton) {
  updateProfileMainButton.addEventListener('click', async () => {
    const statusDiv = document.getElementById('profile-update-status_edit'); // Статус для форми редагування
    if (statusDiv) displayStatus(statusDiv.id, 'Оновлення профілю...', false);

    // Збираємо дані з полів *_edit
    const healthProblemsSelect = document.getElementById(
      'health_problems_edit'
    );
    const selectedHealthProblems = healthProblemsSelect
      ? Array.from(healthProblemsSelect.selectedOptions).map(
          (option) => option.value
        )
      : [];

    const excludedProductsSelect = document.getElementById(
      'excluded_products_edit'
    );
    const selectedExcludedProducts = excludedProductsSelect
      ? Array.from(excludedProductsSelect.selectedOptions).map(
          (option) => option.value
        )
      : [];
    const selectedWeekdays = Array.from(
      document.querySelectorAll(
        'input[name="preferred_training_weekdays_edit"]:checked'
      )
    ).map((cb) => cb.value);

    // Функція для отримання значень (використовуйте вашу, якщо є)
    const getEditInputValue = (idSuffix) =>
      document.getElementById(idSuffix)?.value || null;
    const getEditIntValue = (idSuffix) => {
      const v = getEditInputValue(idSuffix);
      return v ? parseInt(v) : null;
    };
    const getEditFloatValue = (idSuffix) => {
      const v = getEditInputValue(idSuffix);
      return v ? parseFloat(v) : null;
    };

    // Валідація відповідності кількості днів та обраних днів
    const trainingDaysVal = getEditIntValue('training_days_per_week_edit');
    if (
      trainingDaysVal &&
      selectedWeekdays.length > 0 &&
      selectedWeekdays.length !== trainingDaysVal
    ) {
      displayStatus(
        statusDiv.id,
        `Помилка: кількість обраних днів (${selectedWeekdays.length}) не відповідає вказаній кількості тренувань на тиждень (${trainingDaysVal}).`,
        true,
        5000
      );
      return; // Зупиняємо відправку
    }

    const profileData = {
      full_name: getEditInputValue('full_name_edit'),
      display_name: getEditInputValue('display_name_edit'),
      email: getEditInputValue('email_edit') || null,
      age: getEditIntValue('age_edit'),
      gender: getEditInputValue('gender_edit'),
      weight: getEditFloatValue('weight_edit'),
      height: getEditIntValue('height_edit'),
      goal: getEditInputValue('goal_edit'),
      daytime_activity: getEditInputValue('daytime_activity_edit'),
      type_of_training: getEditInputValue('type_of_training_edit'),
      level_of_training: getEditInputValue('level_of_training_edit'),
      health_problems:
        selectedHealthProblems.length > 0 ? selectedHealthProblems : null,
      other_health_problems: getEditInputValue('other_health_problems_edit'),
      excluded_products:
        selectedExcludedProducts.length > 0 ? selectedExcludedProducts : null,
      other_excluded_products: getEditInputValue(
        'other_excluded_products_edit'
      ),
      number_of_meals: getEditInputValue('number_of_meals_edit'),
      instagram_link: getEditInputValue('instagram_link_edit') || null,
      telegram_link: getEditInputValue('telegram_link_edit') || null,
      training_days_per_week: getEditIntValue('training_days_per_week_edit'),
      preferred_training_weekdays:
        selectedWeekdays.length > 0 ? selectedWeekdays : null,
    };

    try {
      const { data, response } = await fetchWithAuth(
        `${baseURL}/profile/my-profile`,
        {
          method: 'PUT',
          body: JSON.stringify(profileData),
        }
      );

      if (!response.ok) {
        // Використовуємо 'data', де вже є розпарсена помилка з fetchWithAuth
        throw new Error(data?.detail || `Помилка сервера: ${response.status}`);
      }

      const successMessage = 'Профіль успішно оновлено =)';
      if (statusDiv) displayStatus(statusDiv.id, successMessage, false, 3000); // Повідомлення на 3 сек

      // Після успішного оновлення, переходимо на "Мій профіль" та оновлюємо там дані
      // Затримка, щоб користувач побачив повідомлення про успіх
      setTimeout(() => {
        const myProfileButton = document.querySelector(
          '#profile .sub-tab-link[onclick*="profile-view"]'
        );
        if (myProfileButton) {
          openProfileSubTab({ currentTarget: myProfileButton }, 'profile-view');
          // loadAndDisplayUserProfileViewData() буде викликано всередині openProfileSubTab
        }
      }, 1500); // 1.5 секунди затримка перед переходом
    } catch (error) {
      console.error('Помилка оновлення профілю:', error);
      displayStatus(statusDiv.id, `Помилка: ${error.message}`, true, 5000);

      // Перевіряємо, чи помилка стосується email
      if (error.message && error.message.toLowerCase().includes('email')) {
        const emailInput = document.getElementById('email_edit');
        if (emailInput) {
          // Підсвічуємо поле
          emailInput.style.borderColor = 'red';

          // --- ОСНОВНА ЗМІНА ТУТ ---
          // Додаємо затримку 1.5 секунди перед прокруткою
          setTimeout(() => {
            emailInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 1500); // 1.5 секунди

          // Знімаємо підсвітку через 5 секунд
          setTimeout(() => {
            emailInput.style.borderColor = '';
          }, 5000);
        }
      }
    }
  });
}

// Функція, яка контролює, щоб користувач не міг обрати більше 4 днів бажаних днів тренувань
function updateWeekdaySelectionHint(container) {
  const hint = document.getElementById('weekdays-edit-hint');
  if (!container || !hint) return;

  const checkedCount = container.querySelectorAll(
    'input[type="checkbox"]:checked'
  ).length;
  const maxDays = 4;
  hint.textContent = `Обрано ${checkedCount} з ${maxDays} можливих`;
  hint.style.color = checkedCount > maxDays ? 'red' : '#aaa';
}

function initializeWeekdaySelectorLogic() {
  const container = document.getElementById(
    'preferred_training_weekdays_edit_container'
  );
  if (!container || container.dataset.initialized) return;

  container.dataset.initialized = 'true'; // Запобігаємо повторній ініціалізації

  container.addEventListener('change', (event) => {
    if (event.target.type === 'checkbox') {
      const checkedCount = container.querySelectorAll(
        'input[type="checkbox"]:checked'
      ).length;
      const maxDays = 4;
      if (checkedCount > maxDays) {
        alert(`Можна обрати не більше ${maxDays} днів.`);
        event.target.checked = false;
      }
      updateWeekdaySelectionHint(container);
    }
  });

  // Оновлюємо лічильник при першому завантаженні
  updateWeekdaySelectionHint(container);
}

// Ініціалізація кнопки розгортання списку чекбоксів днів тижнів у профілі
function initializeWeekdaysToggleForEditForm() {
  const toggleButton = document.getElementById('toggleWeekdaysBtn_edit');
  const checklistContainer = document.getElementById(
    'preferred_training_weekdays_edit_container'
  );

  if (toggleButton && checklistContainer) {
    if (toggleButton.dataset.listenerAttached === 'true') return;
    toggleButton.dataset.listenerAttached = 'true';

    checklistContainer.classList.remove('expanded');
    toggleButton.classList.remove('active');

    toggleButton.addEventListener('click', () => {
      toggleButton.classList.toggle('active');
      checklistContainer.classList.toggle('expanded');
    });
  }
}

/**
 * Ініціалізує логіку для форми зміни пароля.
 */
function initializePasswordChangeForm() {
  const form = document.getElementById('change-password-form');
  // Запобігаємо повторному додаванню слухача
  if (!form || form.dataset.listenerAttached === 'true') {
    return;
  }
  form.dataset.listenerAttached = 'true';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldPassword = document.getElementById('old_password').value;
    const newPassword = document.getElementById('new_password').value;
    const confirmPassword = document.getElementById(
      'confirm_new_password'
    ).value;
    const statusDivId = 'change-password-status';

    if (newPassword.length < 8) {
      displayStatus(
        statusDivId,
        'Новий пароль має містити щонайменше 8 символів.',
        true,
        4000
      );
      return;
    }

    if (newPassword !== confirmPassword) {
      displayStatus(statusDivId, 'Нові паролі не співпадають.', true, 4000);
      return;
    }

    displayStatus(statusDivId, 'Зміна паролю...', false);

    try {
      const { data, response } = await fetchWithAuth(
        `${baseURL}/profile/change-password`,
        {
          method: 'POST',
          body: JSON.stringify({
            old_password: oldPassword,
            new_password: newPassword,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(data.detail || 'Не вдалося змінити пароль.');
      }

      displayStatus(statusDivId, 'Пароль успішно змінено!', false, 5000);
      form.reset(); // Очищуємо поля форми
    } catch (error) {
      console.error('Помилка зміни паролю:', error);
      displayStatus(statusDivId, `Помилка: ${error.message}`, true, 5000);
    }
  });
}

/**
 * Завантажує та відображає список користувачів для вкладки "Спільнота".
 * @param {string|null} searchTerm - Рядок для пошуку.
 */
async function loadCommunityUsers(searchTerm = null) {
  const userListContainer = document.getElementById(
    'community-user-list-container'
  );
  const searchInput = document.getElementById('user-search-input'); // Для отримання значення, якщо searchTerm не передано

  if (!userListContainer) {
    console.error('Елемент #community-user-list-container не знайдено.');
    return;
  }

  userListContainer.innerHTML = '<p>Завантаження списку користувачів...</p>';

  // --- NEW: Динамічне формування URL ---
  let url = `${baseURL}/community/users`;

  if (searchTerm) {
    // Якщо є пошуковий термін, додаємо його до URL. Ліміт не вказуємо.
    url += `?search=${encodeURIComponent(searchTerm)}`;
    //console.log(`Пошук користувачів за запитом: ${searchTerm}`);
  } else {
    // Якщо пошуку немає, завантажуємо лише 15 користувачів за замовчуванням.
    url += `?limit=15`;
    //console.log("Завантаження початкового списку користувачів (ліміт 15).");
  }
  // --- Кінець формування URL ---

  try {
    const { data: users, response } = await fetchWithAuth(url);
    if (!response.ok) {
      // Використовуємо 'users' (перейменована 'data'), де вже є розпарсена помилка
      throw new Error(
        users?.detail || `Помилка завантаження списку: ${response.status}`
      );
    }

    renderCommunityUserList(users);
  } catch (error) {
    console.error('Помилка завантаження списку користувачів спільноти:', error);
    userListContainer.innerHTML = `<p style="color: red;">Не вдалося завантажити список користувачів: ${error.message}</p>`;
  }
}

/**
 * Відображає список користувачів у вкладці "Спільнота".
 * @param {Array} users - Масив об'єктів користувачів (CommunityUserListItem).
 */
function renderCommunityUserList(users) {
  const userListContainer = document.getElementById(
    'community-user-list-container'
  );
  if (!userListContainer) {
    console.error('Елемент #community-user-list-container не знайдено.');
    return;
  }

  if (!users || users.length === 0) {
    userListContainer.innerHTML =
      '<p>Користувачів не знайдено або ще ніхто не зареєструвався.</p>';
    return;
  }

  // Сортування: лайкнуті поточним користувачем перші, потім не призупинені, потім призупинені,
  // потім за кількістю тренувань (спадання), потім за загальною кількістю лайків (спадання)
  users.sort((a, b) => {
    if (a.is_liked_by_current_user && !b.is_liked_by_current_user) return -1;
    if (!a.is_liked_by_current_user && b.is_liked_by_current_user) return 1;
    if (a.is_suspended && !b.is_suspended) return 1;
    if (!a.is_suspended && b.is_suspended) return -1;
    const completedTrainingsDiff =
      (b.completed_trainings_count || 0) - (a.completed_trainings_count || 0);
    if (completedTrainingsDiff !== 0) return completedTrainingsDiff;
    return (b.total_likes_received || 0) - (a.total_likes_received || 0);
  });

  const ul = document.createElement('ul');
  ul.id = 'community-user-list';

  users.forEach((user) => {
    // 'user' тут - це об'єкт типу CommunityUserListItem
    const li = document.createElement('li');
    li.dataset.displayName = user.display_name;
    if (user.is_suspended) {
      li.classList.add('suspended-user');
    }

    const nameDetailsDiv = document.createElement('div');
    nameDetailsDiv.className = 'community-user-details';

    if (user.is_trainer) {
      const trainerIndicator = document.createElement('span');
      trainerIndicator.className = 'trainer-indicator';
      trainerIndicator.title = 'Тренер';
      trainerIndicator.textContent = 'Т';
      nameDetailsDiv.appendChild(trainerIndicator);
    }

    const displayNameSpan = document.createElement('span');
    displayNameSpan.textContent = user.display_name;
    displayNameSpan.className = 'community-user-name';
    displayNameSpan.style.cursor = 'pointer';
    displayNameSpan.addEventListener('click', () =>
      handleCommunityUserClick(user.display_name)
    );
    nameDetailsDiv.appendChild(displayNameSpan);

    li.appendChild(nameDetailsDiv);

    const statsContainer = document.createElement('div');
    statsContainer.className = 'community-user-stats';

    const trainingsCountSpan = document.createElement('span');
    trainingsCountSpan.textContent = `${user.completed_trainings_count || 0}`;
    trainingsCountSpan.className = 'community-user-trainings';
    statsContainer.appendChild(trainingsCountSpan);

    // --- КЛІКАБЕЛЬНИЙ БЛОК З КІЛЬКІСТЮ ЛАЙКІВ ---
    const totalLikesClickableSpan = document.createElement('span');
    totalLikesClickableSpan.className =
      'community-user-total-likes clickable-likes'; // Додав .clickable-likes
    totalLikesClickableSpan.dataset.targetUserPhone = user.phone; // Потрібен телефон для API
    totalLikesClickableSpan.dataset.isLiked =
      user.is_liked_by_current_user.toString();
    totalLikesClickableSpan.dataset.currentTotal =
      user.total_likes_received || 0;

    const heartIconInTotal = document.createElement('span');
    heartIconInTotal.className = 'like-icon-display';
    heartIconInTotal.innerHTML = user.is_liked_by_current_user ? '❤️' : '🖤';

    const countNumberSpan = document.createElement('span'); // <--- ВЖЕ МАЄ БУТИ SPAN
    countNumberSpan.className = 'like-count-number';
    countNumberSpan.textContent = ` ${user.total_likes_received || 0}`;

    totalLikesClickableSpan.appendChild(heartIconInTotal);
    totalLikesClickableSpan.appendChild(countNumberSpan);
    totalLikesClickableSpan.title = user.is_liked_by_current_user
      ? 'Зняти лайк'
      : 'Поставити лайк';

    totalLikesClickableSpan.addEventListener('click', (e) => {
      e.stopPropagation(); // Щоб не спрацював клік на весь li, якщо він є
      handleGenericListLikeClick(e.currentTarget, 'community'); // Новий обробник
    });
    statsContainer.appendChild(totalLikesClickableSpan);
    // --- КІНЕЦЬ КЛІКАБЕЛЬНОГО БЛОКУ ЛАЙКІВ ---

    li.appendChild(statsContainer);
    ul.appendChild(li);
  });

  userListContainer.innerHTML = '';
  userListContainer.appendChild(ul);
}

/**
 * Обробник кліку на користувача у списку спільноти.
 * @param {string} displayName - Display name обраного користувача.
 */
function handleCommunityUserClick(displayName) {
  //console.log(`Клікнуто на користувача: ${displayName}`);
  displayPublicUserProfile(displayName); // Функція для завантаження та відображення публічного профілю
}

// Додаємо обробники для пошуку
const userSearchButton = document.getElementById('user-search-button');
const userSearchInput = document.getElementById('user-search-input');

if (userSearchButton && userSearchInput) {
  // Обробник для кліку на кнопку "Знайти"
  userSearchButton.addEventListener('click', () => {
    const searchTerm = userSearchInput.value.trim();
    if (searchTerm) {
      loadCommunityUsers(searchTerm);
    }
  });

  // Обробник для натискання Enter в полі пошуку
  userSearchInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
      const searchTerm = userSearchInput.value.trim();
      // Запускаємо пошук, тільки якщо є що шукати
      if (searchTerm) {
        loadCommunityUsers(searchTerm);
      }
    }
  });

  // <<< NEW: Обробник для очищення поля пошуку >>>
  // Спрацьовує при кожній зміні тексту в полі вводу
  userSearchInput.addEventListener('input', () => {
    // Якщо поле стало порожнім, автоматично повертаємо початковий список
    if (userSearchInput.value.trim() === '') {
      loadCommunityUsers(); // Викликаємо без аргументів
    }
  });
}

/**
 * Завантажує та відображає публічний профіль обраного користувача.
 * @param {string} displayName - Display name користувача.
 */
async function displayPublicUserProfile(displayName) {
  const profileDisplayContainer = document.getElementById(
    'community-selected-user-profile'
  );
  if (!profileDisplayContainer) {
    console.error('Елемент #community-selected-user-profile не знайдено.');
    return;
  }

  profileDisplayContainer.innerHTML = `<p>Завантаження профілю користувача ${displayName}...</p>`;
  profileDisplayContainer.style.display = 'block'; // Робимо видимим

  try {
    const { data: userData, response } = await fetchWithAuth(
      `${baseURL}/community/users/${encodeURIComponent(displayName)}`
    );
    if (!response.ok) {
      // Використовуємо userData, де вже є розпарсена помилка
      let errorMessage = userData?.detail || `Помилка: ${response.status}`;
      if (response.status === 404) {
        errorMessage = `Профіль користувача "${displayName}" не знайдено або недоступний.`;
      }
      throw new Error(errorMessage);
    }

    renderPublicUserProfile(userData, profileDisplayContainer);

    // СКРОЛ ДО ВЕРХНЬОЇ ЧАСТИНИ ВІДОБРАЖЕНОГО ПРОФІЛЮ
    if (profileDisplayContainer.scrollIntoView) {
      profileDisplayContainer.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    } else {
      // Fallback для старих браузерів
      profileDisplayContainer.scrollTop = 0;
    }
  } catch (error) {
    console.error(
      `Помилка завантаження публічного профілю для ${displayName}:`,
      error
    );
    profileDisplayContainer.innerHTML = `<p style="color: red;">Не вдалося завантажити профіль: ${error.message}</p>`;
  }
}

/**
 * Відображає дані публічного профілю.
 * @param {Object} userData - Дані користувача з PublicUserProfileOut.
 * @param {HTMLElement} container - Контейнер для відображення.
 */
function renderPublicUserProfile(userData, container) {
  container.innerHTML = ''; // Очищуємо попередній контент

  // --- Підготовка даних для відображення (допоміжні змінні) ---
  let registrantHtml = 'Не вказано';
  if (userData.who_registered) {
    registrantHtml = `${userData.who_registered.full_name || "Ім'я не вказано"}`;
    if (userData.who_registered.phone) {
      registrantHtml += ` (<a href="tel:${userData.who_registered.phone}" class="link-subtle">${userData.who_registered.phone}</a>)`;
    }
  }

  let suspensionHtml = '';
  if (userData.is_suspended) {
    suspensionHtml = `<div class="profile-section profile-suspension-notice">
                            <p><strong>Статус облікового запису:</strong> Призупинено 
                            ${userData.suspension_date ? ` (з ${new Date(userData.suspension_date).toLocaleDateString('uk-UA')})` : ''}
                            </p>
                          </div>`;
  }

  const goalText = getGoalText(userData.goal);
  const trainingTypeText = getTrainingTypeText(userData.type_of_training);
  const registrationDateText = userData.registration_date
    ? new Date(userData.registration_date).toLocaleDateString('uk-UA')
    : 'Не вказано';
  // Додай сюди інші get...Text функції, якщо вони потрібні для блоку загальної інформації

  // --- Формування HTML ---

  // 1. Головний заголовок профілю
  let profileHtml = `<h4 class="profile-main-title">Профіль користувача: ${userData.display_name || 'Без імені'}</h4>`;

  // 2. Блок іконок соціальних мереж (якщо є посилання)
  let socialIconsHtml = '';
  let hasSocialLinks = false;
  if (userData.instagram_link || userData.telegram_link) {
    // Показуємо блок, якщо є хоча б одне посилання
    socialIconsHtml += '<div class="public-profile-social-icons">';
    if (userData.instagram_link) {
      let instaLink = userData.instagram_link;
      if (
        !instaLink.startsWith('http') &&
        !instaLink.includes('instagram.com')
      ) {
        instaLink = `https://www.instagram.com/${instaLink.replace('@', '')}`;
      }
      socialIconsHtml += `<a href="${instaLink}" target="_blank" rel="noopener noreferrer" class="social-icon-link" title="Instagram: ${userData.instagram_link}">
                                    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M7.8,2H16.2C19.4,2 22,4.6 22,7.8V16.2A5.8,5.8 0 0,1 16.2,22H7.8C4.6,22 2,19.4 2,16.2V7.8A5.8,5.8 0 0,1 7.8,2M7.6,4A3.6,3.6 0 0,0 4,7.6V16.4C4,18.39 5.61,20 7.6,20H16.4A3.6,3.6 0 0,0 20,16.4V7.6C20,5.61 18.39,4 16.4,4H7.6M17.25,5.5A1.25,1.25 0 0,1 18.5,6.75A1.25,1.25 0 0,1 17.25,8A1.25,1.25 0 0,1 16,6.75A1.25,1.25 0 0,1 17.25,5.5M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9Z" /></svg>
                                </a>`;
      hasSocialLinks = true;
    }
    if (userData.telegram_link) {
      let tgLink = userData.telegram_link;
      if (!tgLink.startsWith('http') && !tgLink.includes('t.me/')) {
        tgLink = `https://t.me/${tgLink.replace('@', '').replace('https://t.me/', '')}`;
      }
      socialIconsHtml += `<a href="${tgLink}" target="_blank" rel="noopener noreferrer" class="social-icon-link" title="Telegram: ${userData.telegram_link}">
                                    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M9.78,18.65L10.26,14.21L17.33,7.6C17.74,7.22 17.26,6.67 16.83,6.92L7.77,12.42L3.62,11.05C3.2,10.91 3.21,10.35 3.65,10.14L19.75,3.08C20.19,2.9 20.79,3.23 20.71,3.73L18.7,17.9C18.63,18.42 18.07,18.68 17.64,18.45L13.5,15.7L11.09,18.05C10.79,18.32 10.39,18.47 10,18.4L9.78,18.65Z" /></svg>
                                </a>`;
      hasSocialLinks = true;
    }
    socialIconsHtml += '</div>';
    if (!hasSocialLinks) socialIconsHtml = ''; // Не показуємо порожній div
  }
  profileHtml += socialIconsHtml; // Додаємо блок іконок (або порожній рядок)

  // 3. Блок "Загальна інформація"
  let generalInfoHtml =
    '<div class="profile-section profile-general-info-block">';
  generalInfoHtml += `<h5 class="profile-section-title">Загальна інформація</h5>`;
  generalInfoHtml += '<div class="profile-view-grid">';

  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Вік:</span> <span class="profile-view-value">${userData.age || 'Не вказано'}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Ціль:</span> <span class="profile-view-value">${getGoalText(userData.goal)}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Вид тренувань:</span> <span class="profile-view-value">${getTrainingTypeText(userData.type_of_training)}</span></div>`;
  generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Дата реєстрації:</span> <span class="profile-view-value">${userData.registration_date ? new Date(userData.registration_date).toLocaleDateString('uk-UA') : 'Не вказано'}</span></div>`;

  // --- ОНОВЛЕНА ЛОГІКА ДЛЯ ТРЕНЕРА v3 (для "Спільнота") ---
  if (userData.is_trainer) {
    // Сценарій 1: Користувач є тренером
    generalInfoHtml += `<div class="profile-view-item profile-view-item-full-width"><span class="profile-trainer-badge">ТРЕНЕР</span></div>`;
  } else if (userData.who_registered) {
    // Сценарій 2: У користувача є дані про тренера (отже, він "з тренером")
    generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Мій тренер:</span> <span class="profile-view-value">${registrantHtml}</span></div>`;
  } else {
    // Сценарій 3: Користувач не тренер і немає даних про тренера (отже, він "без тренера")
    generalInfoHtml += `<div class="profile-view-item"><span class="profile-view-label">Статус:</span> <span class="profile-view-value">Користувач без тренера</span></div>`;
  }
  // --- КІНЕЦЬ ОНОВЛЕНОЇ ЛОГІКИ ---

  generalInfoHtml += '</div></div>';
  profileHtml += generalInfoHtml;

  // 4. Блок "Статистика" (з лайками, кнопкою лайка ТА ПРОПУЩЕНИМИ ТРЕНУВАННЯМИ)
  let statsHtml = '<div class="profile-section profile-stats-block">';
  statsHtml += `<h5 class="profile-section-title">Активність та визнання</h5>`;
  // Клас stats-grid-extended може бути корисним, якщо ти хочеш 4 колонки на ПК
  statsHtml += '<div class="stats-grid stats-grid-extended">';

  statsHtml += `<div class="stat-item">
                    <span class="stat-icon">📅</span> 
                    <span class="stat-value">${userData.active_days_on_platform !== null ? userData.active_days_on_platform : '0'}</span>
                    <span class="stat-label">Активних днів</span>
                  </div>`;
  statsHtml += `<div class="stat-item">
                    <span class="stat-icon">🏆</span>
                    <span class="stat-value">${userData.completed_trainings_count !== null ? userData.completed_trainings_count : '0'}</span>
                    <span class="stat-label">Виконано тренувань</span>
                  </div>`;
  statsHtml += `<div class="stat-item">
                    <span class="stat-icon">⚠️</span>
                    <span class="stat-value">${userData.missed_trainings_count !== null ? userData.missed_trainings_count : '0'}</span>
                    <span class="stat-label">Пропущено тренувань</span>
                  </div>`;
  statsHtml += `<div class="stat-item">
                    <span class="stat-icon">❤️</span>
                    <span class="stat-value">${userData.total_likes_received !== null ? userData.total_likes_received : '0'}</span>
                    <span class="stat-label">Лайків отримано</span>
                  </div>`;
  statsHtml += '</div></div>'; // Кінець stats-grid та profile-stats-block
  profileHtml += statsHtml;

  // 5. Повідомлення про призупинення
  profileHtml += suspensionHtml; // suspensionHtml вже сформовано на початку

  // 6. Блок "Історія прогресу"
  let progressHtmlString = '<div class="profile-section">';
  progressHtmlString += `<h5 class="profile-section-title">Історія прогресу</h5>`;
  if (userData.progress_list && userData.progress_list.length > 0) {
    progressHtmlString += `<div class="table-scroll-wrapper"><table class="compact-progress-table public-profile-table"><thead><tr><th>Дата</th><th>Вага<br><span class="unit-label">(кг)</span></th><th>Груди<br><span class="unit-label">(см)</span></th><th>Талія<br><span class="unit-label">(см)</span></th><th>Живіт<br><span class="unit-label">(см)</span></th><th>Стегна<br><span class="unit-label">(см)</span></th></tr></thead><tbody>`;
    userData.progress_list.forEach((p) => {
      const displayWeight =
        p.weight !== null && p.weight !== undefined ? p.weight : '-';
      const displayChest =
        p.chest !== null && p.chest !== undefined ? p.chest : '-';
      const displayWaist =
        p.waist !== null && p.waist !== undefined ? p.waist : '-';
      const displayAbdomen =
        p.abdomen !== null && p.abdomen !== undefined ? p.abdomen : '-';
      const displayHips =
        p.hips !== null && p.hips !== undefined ? p.hips : '-';
      progressHtmlString += `<tr><td>${new Date(p.date).toLocaleDateString('uk-UA')}</td><td>${displayWeight}</td><td>${displayChest}</td><td>${displayWaist}</td><td>${displayAbdomen}</td><td>${displayHips}</td></tr>`;
    });
    progressHtmlString += `</tbody></table></div>`;
  } else {
    progressHtmlString += `<p class="empty-section-message">Дані прогресу відсутні.</p>`;
  }
  progressHtmlString += '</div>';
  profileHtml += progressHtmlString;

  // 7. Блок "Переваги у вправах" (карусель)
  let preferencesHtmlString =
    '<div class="profile-section exercise-preferences-section">';
  preferencesHtmlString += `<h5 class="profile-section-title">Збережені показники у вправах</h5>`;
  if (
    userData.exercise_preferences_summary &&
    userData.exercise_preferences_summary.length > 0
  ) {
    preferencesHtmlString += `
            <div class="preferences-carousel-container public-profile-preferences-carousel"> <div class="preferences-carousel-viewport">
                    <div class="preferences-carousel-track">`;
    userData.exercise_preferences_summary.forEach((pref) => {
      if (pref.gif_name) {
        preferencesHtmlString += `<div class="exercise-preference-item"><h6>${pref.gif_name}</h6>${generatePublicPreferenceTableHTML(pref)}</div>`;
      }
    });
    preferencesHtmlString += `
                    </div> </div> <div class="carousel-navigation-wrapper"> 
                    <button class="carousel-arrow prev" aria-label="Попередні" onclick="scrollPreferencesCarousel(this, -1)">&#10094;</button>
                    <button class="carousel-arrow next" aria-label="Наступні" onclick="scrollPreferencesCarousel(this, 1)">&#10095;</button>
                </div>
                </div> `;
  } else {
    preferencesHtmlString += `<p class="empty-section-message">Збережені показники у вправах відсутні.</p>`;
  }
  preferencesHtmlString += '</div>'; // Кінець .profile-section для переваг
  profileHtml += preferencesHtmlString;

  // Встановлюємо фінальний HTML
  container.innerHTML = profileHtml;
}

/**
 * Генерує HTML-таблицю для ОДНІЄЇ переваги вправи (тільки фактичні показники користувача).
 * @param {object} preferenceItem - Об'єкт переваги з userData.exercise_preferences_summary.
 * @returns {string} HTML рядок таблиці.
 */
function generatePublicPreferenceTableHTML(preferenceItem) {
  const reps = preferenceItem.reps || [];
  const weights = preferenceItem.weights || [];
  const time = preferenceItem.time || [];

  // Визначаємо максимальну кількість підходів на основі довжини масивів
  const numSets = Math.max(reps.length, weights.length, time.length);

  if (numSets === 0) {
    return '<p style="font-style: italic; color: #aaa; font-size:0.9em;">Дані для підходів відсутні.</p>';
  }

  // Визначаємо, які стовпці мають дані і повинні відображатися
  const showRepsColumn = reps.some((val) => val !== null && val !== undefined);
  const showWeightsColumn = weights.some(
    (val) => val !== null && val !== undefined
  );
  const showTimeColumn = time.some((val) => val !== null && val !== undefined);

  if (!showRepsColumn && !showWeightsColumn && !showTimeColumn) {
    return `<p style="font-style: italic; color: #aaa; font-size:0.9em;">Кількість підходів: ${numSets}. Деталі не вказані.</p>`;
  }

  let tableHeaderHTML = '<th>Підхід</th>';
  if (showRepsColumn) tableHeaderHTML += '<th>Повторення</th>';
  if (showWeightsColumn)
    tableHeaderHTML +=
      '<th>Вага <span class="unit-label-table">(кг)</span></th>';
  if (showTimeColumn)
    tableHeaderHTML +=
      '<th>Час <span class="unit-label-table">(сек)</span></th>';

  let tableHTML = `<div class="table-scroll-wrapper"><table class="compact-exercise-pref-table public-profile-table">
                        <thead><tr>${tableHeaderHTML}</tr></thead>
                        <tbody>`;

  for (let i = 0; i < numSets; i++) {
    const setNumber = i + 1;
    let rowContentHTML = `<td>${setNumber}</td>`;

    if (showRepsColumn) {
      const repVal = reps[i] !== null && reps[i] !== undefined ? reps[i] : '-';
      rowContentHTML += `<td>${repVal}</td>`;
    }
    if (showWeightsColumn) {
      const weightVal =
        weights[i] !== null && weights[i] !== undefined ? weights[i] : '-';
      rowContentHTML += `<td>${weightVal}</td>`;
    }
    if (showTimeColumn) {
      const timeVal = time[i] !== null && time[i] !== undefined ? time[i] : '-';
      rowContentHTML += `<td>${timeVal}</td>`;
    }
    tableHTML += `<tr>${rowContentHTML}</tr>`;
  }

  tableHTML += `</tbody></table></div>`;
  return tableHTML;
}

/**
 * Прокручує карусель переваг.
 * @param {HTMLElement} button - Натиснута кнопка (стрілка).
 * @param {number} direction - Напрямок: -1 для ліворуч, 1 для праворуч.
 */
function scrollPreferencesCarousel(button, direction) {
  const carouselContainer = button.closest('.preferences-carousel-container');
  if (!carouselContainer) return;
  const viewport = carouselContainer.querySelector(
    '.preferences-carousel-viewport'
  );
  if (!viewport) return;

  const firstSlide = viewport.querySelector('.exercise-preference-item');
  if (!firstSlide) return; // Немає слайдів для прокрутки

  // Розраховуємо ширину одного слайда + його правий margin
  const slideWidth = firstSlide.offsetWidth; // Ширина контенту + padding + border
  const slideMarginRight =
    parseFloat(window.getComputedStyle(firstSlide).marginRight) || 0;
  const scrollAmount = slideWidth + slideMarginRight;

  viewport.scrollBy({
    left: scrollAmount * direction,
    behavior: 'smooth',
  });

  // Опціонально: Оновлення стану кнопок (якщо ти реалізував updateCarouselButtonsState)
  // Потрібно невелику затримку, щоб scrollBy встиг завершити анімацію перед перевіркою
  setTimeout(() => updateCarouselButtonsState(viewport), 350); // 350ms - приблизний час анімації smooth
}

// Опціональна функція для оновлення стану кнопок каруселі (неактивні, якщо досягнуто краю)
function updateCarouselButtonsState(viewport) {
  if (!viewport) return;
  const track = viewport.querySelector('.preferences-carousel-track');
  const prevButton = viewport
    .closest('.preferences-carousel-container')
    .querySelector('.carousel-arrow.prev');
  const nextButton = viewport
    .closest('.preferences-carousel-container')
    .querySelector('.carousel-arrow.next');

  if (!track || !prevButton || !nextButton) return;

  prevButton.disabled = viewport.scrollLeft <= 0;
  nextButton.disabled =
    viewport.scrollLeft + viewport.offsetWidth >= track.scrollWidth - 5; // -5 для невеликої похибки
}

// Загрузка данных прогресса
async function loadProgressData() {
  const tableBody = document.getElementById('progress-table');
  const statusElementId = 'progress-add-status'; // Просто зберігаємо ID

  if (!tableBody) return; // Виходимо, якщо таблиця не знайдена
  tableBody.innerHTML = ''; // Очищуємо таблицю
  displayStatus(statusElementId, 'Завантаження прогресу...'); // Використовуємо нашу функцію

  try {
    // Використовуємо fetchWithAuth
    const { data, response } = await fetchWithAuth(
      `${baseURL}/profile/progress`
    );

    // Перевірка відповіді (fetchWithAuth вже обробив 401)
    if (!response.ok) {
      // Використовуємо 'data', де вже є розпарсена помилка
      throw new Error(
        data?.detail || `Помилка завантаження: ${response.status}`
      );
    }

    displayStatus(statusElementId, ''); // Очищуємо статус

    if (data.length === 0) {
      tableBody.innerHTML =
        '<tr><td colspan="6">Записи прогресу відсутні.</td></tr>';
    } else {
      data.sort((a, b) => new Date(b.date) - new Date(a.date)); // Сортуємо від новіших до старіших
      data.forEach((item) => {
        tableBody.innerHTML += `<tr>
                    <td>${new Date(item.date).toLocaleDateString('uk-UA')}</td>
                    <td>${item.weight ?? '-'}</td>
                    <td>${item.chest ?? '-'}</td>
                    <td>${item.waist ?? '-'}</td>
                    <td>${item.abdomen ?? '-'}</td>
                    <td>${item.hips ?? '-'}</td>
                </tr>`;
      });
    }
  } catch (error) {
    console.error('Помилка під час завантаження даних прогресу:', error);
    displayStatus(statusElementId, `Помилка: ${error.message}`, true); // Використовуємо нашу функцію
  }
}

// Добавление прогресса
const addProgressButton = document.getElementById('add-progress');
if (addProgressButton) {
  addProgressButton.addEventListener('click', async () => {
    const statusDiv = document.getElementById('progress-add-status');
    const weight = document.getElementById('progress_weight')?.value || null;
    const chest = document.getElementById('progress_chest')?.value || null;
    const waist = document.getElementById('progress_waist')?.value || null;
    const abdomen = document.getElementById('progress_abdomen')?.value || null;
    const hips = document.getElementById('progress_hips')?.value || null;

    // Перевірка, чи хоча б одне поле заповнене
    if (!weight && !chest && !waist && !abdomen && !hips) {
      if (statusDiv)
        statusDiv.innerText =
          'Будь ласка, заповніть хоча б одне поле прогресу.';
      return;
    }

    const progressData = {
      weight: weight ? parseFloat(weight) : null,
      chest: chest ? parseInt(chest) : null,
      waist: waist ? parseInt(waist) : null,
      abdomen: abdomen ? parseInt(abdomen) : null,
      hips: hips ? parseInt(hips) : null,
    };

    if (statusDiv) statusDiv.innerText = 'Додавання запису...';

    try {
      // Використовуємо fetchWithAuth
      const { data, response } = await fetchWithAuth(
        `${baseURL}/profile/progress`,
        {
          method: 'POST',
          body: JSON.stringify(progressData),
        }
      );

      // Перевірка відповіді (fetchWithAuth вже обробив 401)
      if (!response.ok) {
        throw new Error(
          errorData.detail || `Помилка сервера: ${response.status}`
        );
      }

      if (response.ok) {
        const successMessage = 'Прогрес успішно додано!'; // Зберігаємо текст повідомлення

        // 1. Відображаємо повідомлення одразу
        if (statusDiv) {
          statusDiv.innerText = successMessage;
          statusDiv.style.color = 'lightgreen';
        }

        // 2. Очищуємо поля вводу одразу
        document.getElementById('progress_weight').value = '';
        document.getElementById('progress_chest').value = '';
        document.getElementById('progress_waist').value = '';
        document.getElementById('progress_abdomen').value = '';
        document.getElementById('progress_hips').value = '';

        // 3. Встановлюємо таймер на 2 секунди для скролу та очищення повідомлення
        setTimeout(() => {
          // 4. Оновлюємо таблицю
          loadProgressData(); // функція оновлення даних в таблиці

          // 5. Потім очищаємо повідомлення (перевіряючи вміст)
          if (statusDiv && statusDiv.innerText === successMessage) {
            statusDiv.innerText = '';
            statusDiv.style.color = 'white'; // Повертаємо стандартний колір
          }
        }, 2000); // Затримка 2000 мс (2 секунди)
      } else {
        throw new Error(
          errorData.detail || `Помилка сервера: ${response.status}`
        );
      }
    } catch (error) {
      console.error('Помилка додавання прогресу:', error);
      if (statusDiv) statusDiv.innerText = `Помилка: ${error.message}`;
      if (statusDiv) statusDiv.style.color = 'red';
    }
  });
}

// --- Вкладка "Рейтинги" (ОНОВЛЕНА ВЕРСІЯ) ---

/**
 * Перемикає видимість під-вкладок у розділі "Рейтинги".
 */
function openRatingsSubTab(event, subTabContentId) {
  const ratingsContainer = document.getElementById('ratings');
  if (!ratingsContainer) return;

  ratingsContainer
    .querySelectorAll('.leaderboard-sub-content')
    .forEach((content) => {
      content.style.display = 'none';
      content.classList.remove('active-sub-content');
    });

  ratingsContainer
    .querySelectorAll('.ratings-sub-tabs .sub-tab-link')
    .forEach((link) => {
      link.classList.remove('active');
    });

  const activeContent = document.getElementById(subTabContentId);
  if (activeContent) {
    activeContent.style.display = 'block';
    activeContent.classList.add('active-sub-content');
  }
  if (event && event.currentTarget) {
    event.currentTarget.classList.add('active');
  }

  // Завантажуємо дані для відповідної під-вкладки
  switch (subTabContentId) {
    case 'leaderboard-total':
      loadTotalTrainingsLeaderboard();
      break;
    case 'leaderboard-weekly':
      loadWeeklyTrainingsLeaderboard();
      break;
    case 'leaderboard-weight-loss':
      loadWeightLossLeaderboard();
      break;
    case 'leaderboard-weight-gain':
      loadWeightGainLeaderboard();
      break;
    case 'leaderboard-hip-thrust':
      loadHipThrustLeaderboard();
      break;
    case 'leaderboard-pull-ups':
      loadPullUpsLeaderboard();
      break;
  }
}

/**
 * Універсальна функція для завантаження та відображення будь-якого рейтингу.
 * @param {string} endpoint - URL ендпоінту API.
 * @param {string} containerId - ID контейнера для відображення.
 * @param {string} title - Заголовок рейтингу.
 * @param {Function} renderFunction - Функція для рендерингу даних.
 * @param {number} limit - Максимальна кількість записів для відображення.
 */
async function loadLeaderboardData(
  endpoint,
  containerId,
  title,
  renderFunction,
  limit
) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.error(`Елемент #${containerId} не знайдено.`);
    return;
  }
  container.innerHTML = `
        <div id="leaderboard-container">
            <h6>${title}</h6>
            <ul id="${containerId}-list" class="leaderboard-list"></ul>
            <p id="${containerId}-status" class="status-message" style="text-align: center; color: #888;"></p>
        </div>
    `;

  const listElement = document.getElementById(`${containerId}-list`);
  const statusElement = document.getElementById(`${containerId}-status`);

  statusElement.textContent = 'Завантаження рейтингу...';

  try {
    const { data, response } = await fetchWithAuth(`${baseURL}${endpoint}`);
    if (!response.ok) {
      throw new Error(
        data.detail || `Помилка завантаження: ${response.status}`
      );
    }
    renderFunction(data, listElement, statusElement, limit);
  } catch (error) {
    console.error(`Помилка завантаження рейтингу (${title}):`, error);
    statusElement.textContent = `Не вдалося завантажити: ${error.message}`;
    statusElement.style.color = 'red';
  }
}

// Функції-завантажувачі для кожного рейтингу
function loadTotalTrainingsLeaderboard() {
  loadLeaderboardData(
    '/leaderboard/completed-trainings',
    'leaderboard-total',
    '"Тільки системний підхід дасть справжній результат! 🏆" - Tоп за кількістю тренувань (за весь час)',
    renderTrainingsLeaderboard,
    50
  );
}
function loadWeeklyTrainingsLeaderboard() {
  loadLeaderboardData(
    '/leaderboard/weekly-completed-trainings',
    'leaderboard-weekly',
    '"Наполегливість вирішує! 💎" - Tоп за кількістю тренувань (за останні 7 днів)',
    renderTrainingsLeaderboard,
    50
  );
}
function loadWeightLossLeaderboard() {
  loadLeaderboardData(
    '/leaderboard/weight-loss',
    'leaderboard-weight-loss',
    'Топ за втратою ваги (мета "Схуднути")',
    renderPerformanceLeaderboard,
    50
  );
}
function loadWeightGainLeaderboard() {
  loadLeaderboardData(
    '/leaderboard/weight-gain',
    'leaderboard-weight-gain',
    'Топ за набором ваги (мета "Набрати м\'язову масу")',
    renderPerformanceLeaderboard,
    50
  );
}
function loadHipThrustLeaderboard() {
  loadLeaderboardData(
    '/leaderboard/exercise/hip-thrust',
    'leaderboard-hip-thrust',
    'Топ у вправі "Сідничний міст" (за макс. вагою в "кг")',
    renderPerformanceLeaderboard,
    50
  );
}
function loadPullUpsLeaderboard() {
  loadLeaderboardData(
    '/leaderboard/exercise/pull-ups',
    'leaderboard-pull-ups',
    'Топ у вправі "Підтягування широким хватом" (за макс. повтореннями)',
    renderPerformanceLeaderboard,
    50
  );
}

/**
 * ОНОВЛЕНО: Відображає реальну кількість користувачів без порожніх рядків.
 */
function renderTrainingsLeaderboard(
  leaderboardData,
  listElement,
  statusElement,
  limit
) {
  listElement.innerHTML = '';
  statusElement.textContent = '';

  if (!leaderboardData || leaderboardData.length === 0) {
    statusElement.textContent = 'Дані для рейтингу відсутні.';
    return; // Просто виходимо, не створюючи порожніх рядків
  }

  // Перебираємо тільки ті дані, які прийшли з сервера
  leaderboardData.forEach((entry) => {
    const li = document.createElement('li');

    // --- Подальша логіка створення li залишається без змін ---
    const rankSpan = document.createElement('span');
    rankSpan.className = 'rank';
    rankSpan.textContent = `${entry.rank}.`;

    const nameWrapper = document.createElement('span');
    nameWrapper.className = 'name-wrapper';

    if (entry.is_trainer) {
      const trainerIndicator = document.createElement('span');
      trainerIndicator.className = 'trainer-indicator';
      trainerIndicator.title = 'Тренер';
      trainerIndicator.textContent = 'Т';
      nameWrapper.appendChild(trainerIndicator);
    }

    const nameLink = document.createElement('a');
    nameLink.className = 'name leaderboard-name-clickable';
    nameLink.textContent = entry.display_name;
    nameLink.href = '#';
    nameLink.dataset.displayName = entry.display_name;
    nameLink.addEventListener('click', function (e) {
      e.preventDefault();
      showUserProfileFromAnywhere(this.dataset.displayName);
    });
    nameWrapper.appendChild(nameLink);

    const statsAndLikeWrapper = document.createElement('div');
    statsAndLikeWrapper.className = 'leaderboard-stats-like';

    const countSpan = document.createElement('span');
    countSpan.className = 'count';
    countSpan.textContent = `${entry.completed_trainings_count}`;
    statsAndLikeWrapper.appendChild(countSpan);

    const totalLikesClickableSpan = document.createElement('span');
    totalLikesClickableSpan.className = 'total-likes-count clickable-likes';
    totalLikesClickableSpan.dataset.targetUserPhone = entry.phone;
    totalLikesClickableSpan.dataset.isLiked =
      entry.is_liked_by_current_user.toString();
    totalLikesClickableSpan.dataset.currentTotal =
      entry.total_likes_received || 0;

    const heartIconInTotal = document.createElement('span');
    heartIconInTotal.className = 'like-icon-display';
    heartIconInTotal.innerHTML = entry.is_liked_by_current_user ? '❤️' : '🖤';

    const countNumberSpan = document.createElement('span');
    countNumberSpan.className = 'like-count-number';
    countNumberSpan.textContent = ` ${entry.total_likes_received || 0}`;

    totalLikesClickableSpan.appendChild(heartIconInTotal);
    totalLikesClickableSpan.appendChild(countNumberSpan);
    totalLikesClickableSpan.title = entry.is_liked_by_current_user
      ? 'Зняти лайк'
      : 'Поставити лайк';

    totalLikesClickableSpan.addEventListener('click', (e) => {
      handleGenericListLikeClick(e.currentTarget, 'leaderboard');
    });
    statsAndLikeWrapper.appendChild(totalLikesClickableSpan);

    li.appendChild(rankSpan);
    li.appendChild(nameWrapper);
    li.appendChild(statsAndLikeWrapper);

    if (entry.is_suspended) li.classList.add('suspended-in-leaderboard');
    if (entry.rank === 1) li.classList.add('rank-1');
    else if (entry.rank === 2) li.classList.add('rank-2');
    else if (entry.rank === 3) li.classList.add('rank-3');

    listElement.appendChild(li);
  });
}

/**
 * НОВА ФУНКЦІЯ: Відображає дані рейтингів, де основний показник - числове значення (вага, повторення).
 */
function renderPerformanceLeaderboard(
  leaderboardData,
  listElement,
  statusElement,
  limit
) {
  listElement.innerHTML = '';
  statusElement.textContent = '';

  if (!leaderboardData || leaderboardData.length === 0) {
    statusElement.textContent = 'Дані для рейтингу відсутні.';
    return; // Просто виходимо, не створюючи порожніх рядків
  }

  // Перебираємо тільки ті дані, які прийшли з сервера
  leaderboardData.forEach((entry) => {
    const li = document.createElement('li');

    // --- Подальша логіка створення li залишається без змін ---
    const rankSpan = document.createElement('span');
    rankSpan.className = 'rank';
    rankSpan.textContent = `${entry.rank}.`;

    const nameWrapper = document.createElement('span');
    nameWrapper.className = 'name-wrapper';

    if (entry.is_trainer) {
      const trainerIndicator = document.createElement('span');
      trainerIndicator.className = 'trainer-indicator';
      trainerIndicator.title = 'Тренер';
      trainerIndicator.textContent = 'Т';
      nameWrapper.appendChild(trainerIndicator);
    }

    const nameLink = document.createElement('a');
    nameLink.className = 'name leaderboard-name-clickable';
    nameLink.textContent = entry.display_name;
    nameLink.href = '#';
    nameLink.dataset.displayName = entry.display_name;
    nameLink.addEventListener('click', function (e) {
      e.preventDefault();
      showUserProfileFromAnywhere(this.dataset.displayName);
    });
    nameWrapper.appendChild(nameLink);

    const statsAndLikeWrapper = document.createElement('div');
    statsAndLikeWrapper.className = 'leaderboard-stats-like';

    const countSpan = document.createElement('span');
    countSpan.className = 'count';
    countSpan.textContent = `${entry.value}`; // ВИДАЛЕНО ${entry.unit}
    statsAndLikeWrapper.appendChild(countSpan);

    const totalLikesClickableSpan = document.createElement('span');
    totalLikesClickableSpan.className = 'total-likes-count clickable-likes';
    totalLikesClickableSpan.dataset.targetUserPhone = entry.phone;
    totalLikesClickableSpan.dataset.isLiked =
      entry.is_liked_by_current_user.toString();
    totalLikesClickableSpan.dataset.currentTotal =
      entry.total_likes_received || 0;

    const heartIconInTotal = document.createElement('span');
    heartIconInTotal.className = 'like-icon-display';
    heartIconInTotal.innerHTML = entry.is_liked_by_current_user ? '❤️' : '🖤';

    const countNumberSpan = document.createElement('span');
    countNumberSpan.className = 'like-count-number';
    countNumberSpan.textContent = ` ${entry.total_likes_received || 0}`;

    totalLikesClickableSpan.appendChild(heartIconInTotal);
    totalLikesClickableSpan.appendChild(countNumberSpan);
    totalLikesClickableSpan.title = entry.is_liked_by_current_user
      ? 'Зняти лайк'
      : 'Поставити лайк';

    totalLikesClickableSpan.addEventListener('click', (e) => {
      handleGenericListLikeClick(e.currentTarget, 'leaderboard');
    });
    statsAndLikeWrapper.appendChild(totalLikesClickableSpan);

    li.appendChild(rankSpan);
    li.appendChild(nameWrapper);
    li.appendChild(statsAndLikeWrapper);

    if (entry.is_suspended) li.classList.add('suspended-in-leaderboard');
    if (entry.rank === 1) li.classList.add('rank-1');
    else if (entry.rank === 2) li.classList.add('rank-2');
    else if (entry.rank === 3) li.classList.add('rank-3');

    listElement.appendChild(li);
  });
}

/**
 * Обробляє клік на лайк у списках (Спільнота, Рейтинг).
 * Оновлює лише клікабельний лічильник лайків.
 * @param {HTMLElement} buttonElement - Елемент, на який клікнули (span з лайками).
 * @param {string} context - 'community' або 'leaderboard' (наразі не використовується для різної логіки).
 */
async function handleGenericListLikeClick(buttonElement, context) {
  // context поки залишаємо, може знадобитися
  const targetUserPhone = buttonElement.dataset.targetUserPhone;
  let currentlyLiked = buttonElement.dataset.isLiked === 'true';
  let currentTotalOnElement = parseInt(
    buttonElement.dataset.currentTotal || '0'
  );

  const heartIconSpan = buttonElement.querySelector('.like-icon-display');
  const countNumberSpan = buttonElement.querySelector('.like-count-number');

  if (!targetUserPhone) {
    console.error(
      'Не вдалося отримати телефон цільового користувача для лайка.'
    );
    return;
  }

  buttonElement.style.pointerEvents = 'none';
  buttonElement.classList.add('processing-like');

  try {
    let newTotalLikesCalculated;
    if (currentlyLiked) {
      await unlikeUserProfileAPI(targetUserPhone);
      if (heartIconSpan) heartIconSpan.innerHTML = '🖤'; // Сіре/чорне сердечко (або ♡)
      buttonElement.title = 'Поставити лайк';
      buttonElement.dataset.isLiked = 'false';
      newTotalLikesCalculated = Math.max(0, currentTotalOnElement - 1);
    } else {
      await likeUserProfileAPI(targetUserPhone);
      if (heartIconSpan) heartIconSpan.innerHTML = '❤️'; // Червоне сердечко
      buttonElement.title = 'Зняти лайк';
      buttonElement.dataset.isLiked = 'true';
      newTotalLikesCalculated = currentTotalOnElement + 1;
    }

    if (countNumberSpan) {
      countNumberSpan.textContent = ` ${newTotalLikesCalculated}`;
    }
    buttonElement.dataset.currentTotal = newTotalLikesCalculated.toString();

    // ---- БЛОК ДЛЯ ОНОВЛЕННЯ СЕРДЕЧКА БІЛЯ ІМЕНІ ВИДАЛЕНО ----

    // Якщо після лайка/анлайка потрібно пересортувати список "Спільнота"
    // (щоб лайкнуті піднялися вгору), потрібно перезавантажити список:
    if (context === 'community') {
      // Перезавантажуємо список спільноти, щоб оновити сортування
      // Це може бути не ідеально для UX, якщо список великий,
      // але це найнадійніший спосіб оновити порядок.
      // Ти можеш вирішити, чи потрібне це негайне перезавантаження.
      // loadCommunityUsers(document.getElementById('user-search-input')?.value.trim());
      //console.log("Лайк у спільноті оброблено. Список буде пересортовано при наступному завантаженні/оновленні.");
    }
  } catch (error) {
    console.error(
      `Помилка при ${currentlyLiked ? 'знятті' : 'встановленні'} лайка (${context}):`,
      error
    );
    alert(`Не вдалося виконати дію: ${error.message || 'Помилка сервера'}`);
  } finally {
    buttonElement.style.pointerEvents = 'auto';
    buttonElement.classList.remove('processing-like');
  }
}

/**
 * Програмно відкриває вкладку "Профіль", під-вкладку "Спільнота"
 * та відображає публічний профіль вказаного користувача.
 * @param {string} displayName - Display name користувача для відображення.
 */
async function showUserProfileFromAnywhere(displayName) {
  //console.log(`Навігація до профілю: ${displayName} зі списку рейтингів.`);

  // 1. Знаходимо і "клікаємо" на головну вкладку "Профіль"
  const profileTabButton = Array.from(
    document.querySelectorAll('.tab-link')
  ).find((btn) =>
    btn.getAttribute('onclick')?.includes("openTab(event, 'profile')")
  );
  if (profileTabButton) {
    // openTab очікує event з currentTarget
    openTab({ currentTarget: profileTabButton }, 'profile');
  } else {
    console.error("Кнопка головної вкладки 'Профіль' не знайдена.");
    return;
  }

  // Можлива невелика затримка, щоб DOM встиг оновитися після openTab,
  // особливо якщо openTab має асинхронні операції або важкий рендеринг.
  // Але спочатку спробуємо без неї. Якщо будуть проблеми, можна додати:
  // await new Promise(resolve => setTimeout(resolve, 50));

  // 2. Знаходимо і "клікаємо" на під-вкладку "Спільнота"
  const communitySubTabButton = Array.from(
    document.querySelectorAll('#profile .sub-tab-link')
  ).find((btn) =>
    btn
      .getAttribute('onclick')
      ?.includes("openProfileSubTab(event, 'profile-community')")
  );
  if (communitySubTabButton) {
    // openProfileSubTab очікує event з currentTarget
    // Важливо: openProfileSubTab для 'profile-community' має НЕ викликати loadCommunityUsers() одразу,
    // оскільки ми хочемо показати конкретний профіль, а не весь список.
    // Або, якщо викликає, то displayPublicUserProfile перекриє список.
    openProfileSubTab(
      { currentTarget: communitySubTabButton },
      'profile-community'
    );
  } else {
    console.error("Кнопка під-вкладки 'Спільнота' не знайдена.");
    return;
  }

  // 3. Відображаємо публічний профіль користувача (ця функція вже має скрол)
  await displayPublicUserProfile(displayName);
}
// --- Кінець вкладки "Рейтинги" ---

// --- Функції для вкладки "Тренування" ---

/**
 * Керує видимістю блоків у вкладці "Тренування": список, форма, деталі.
 * @param {'list' | 'form' | 'details'} viewName - Назва вигляду для показу.
 */
function showUserWorkoutView(viewName) {
  const listContainer = document.getElementById('workout-list-container');
  const formContainer = document.getElementById('workout-form-container-user');
  const detailsContainer = document.getElementById('workout-details-container');

  // Ховаємо всі блоки
  if (listContainer) listContainer.style.display = 'none';
  if (formContainer) formContainer.style.display = 'none';
  if (detailsContainer) detailsContainer.style.display = 'none';

  // Показуємо потрібний
  switch (viewName) {
    case 'list':
      if (listContainer) listContainer.style.display = 'block';
      break;
    case 'form':
      if (formContainer) formContainer.style.display = 'block';
      break;
    case 'details':
      if (detailsContainer) detailsContainer.style.display = 'block';
      break;
  }
}

/**
 * Перевіряє статус користувача і відображає кнопку для створення тренування.
 */
async function checkAndDisplayIndependentFeatures() {
  const addWorkoutBtn = document.getElementById(
    'show-independent-workout-form-btn'
  );
  if (!addWorkoutBtn) return;

  try {
    // Завантажуємо дані профілю, якщо їх ще немає в кеші
    if (!currentUserProfileData) {
      currentUserProfileData = await fetchCurrentProfileDataOnce();
    }

    // Перевіряємо поле is_independent (яке має бути в /profile)
    // Припускаємо, що бекенд повертає це поле. Якщо ні - його потрібно додати.
    const userIsIndependent = currentUserProfileData?.is_independent === true;

    if (userIsIndependent) {
      addWorkoutBtn.style.display = 'inline-block';
      //console.log("Користувач 'самостійний', кнопка створення тренування показана.");
    } else {
      addWorkoutBtn.style.display = 'none';
    }
  } catch (error) {
    console.error("Помилка перевірки статусу 'самостійний':", error);
    addWorkoutBtn.style.display = 'none';
  }
}

/**
 * ОНОВЛЕНО: Відображає кнопки "Редагувати" або "Дублювати" залежно від статусу.
 */
async function loadWorkoutList(isLoadMore = false) {
  const workoutListContainer = document.getElementById('workout-list');
  const statusDiv = document.getElementById('workout-list-status');
  const loadMoreContainer = document.getElementById(
    'workout-load-more-container'
  );

  if (!workoutListContainer || !statusDiv || !loadMoreContainer) return;
  if (isLoadingMoreUserWorkouts) return;
  isLoadingMoreUserWorkouts = true;
  displayStatus('workout-list-status', 'Завантаження тренувань...');
  loadMoreContainer.innerHTML = '';
  if (!isLoadMore) {
    workoutListContainer.innerHTML = '';
    if (!currentUserProfileData) {
      currentUserProfileData = await fetchCurrentProfileDataOnce().catch(
        () => null
      );
    }
  }
  const skip = isLoadMore ? workoutListContainer.children.length : 0;
  const limit = isLoadMore ? WORKOUTS_PER_PAGE_MORE : WORKOUTS_INITIAL_LOAD;
  try {
    slowConnectionDetector.start('workout-list-status');
    const { data: plans, response } = await fetchWithAuth(
      `${baseURL}/training_plans?skip=${skip}&limit=${limit}`
    );
    if (!response.ok)
      throw new Error(plans.detail || `Помилка сервера: ${response.status}`);

    // Очищуємо прапорець "генерація в процесі", якщо тренування вже завантажились
    if (plans && plans.length > 0) {
      plans.forEach((plan) => {
        const flagKey = `generation_in_progress_${plan.id}`;
        if (localStorage.getItem(flagKey)) {
          console.log(
            `Тренування для плану ${plan.id} завантажено. Видаляємо прапорець генерації.`
          );
          localStorage.removeItem(flagKey);
        }
      });
    }

    if (!isLoadMore && (!plans || plans.length === 0)) {
      workoutListContainer.innerHTML =
        '<p>У вас ще немає призначених тренувань.</p>';
      return;
    }
    if (response.headers.has('x-total-count')) {
      totalUserWorkoutsAvailable = parseInt(
        response.headers.get('x-total-count'),
        10
      );
    }

    plans.forEach((plan) => {
      const listItem = document.createElement('div');
      // ... (код для створення listItem залишається без змін) ...
      listItem.classList.add('workout-list-item');
      listItem.setAttribute('data-plan-id', plan.id);
      if (plan.completed) listItem.classList.add('completed');
      const planDateObj = new Date(plan.date);
      const planDateFormatted = !isNaN(planDateObj)
        ? planDateObj.toLocaleDateString('uk-UA', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })
        : 'Невідома дата';
      const planWeekday = !isNaN(planDateObj)
        ? planDateObj.toLocaleDateString('uk-UA', { weekday: 'short' })
        : '';
      listItem.innerHTML = `
                ${plan.completed ? '<span class="completion-indicator">✔</span>' : ''}
                <span class="workout-list-date">${planDateFormatted} (${planWeekday})</span>
                <span class="workout-list-title">${plan.title || 'Без назви'}</span>
                ${plan.description ? `<p class="workout-list-desc">${plan.description.substring(0, 150)}${plan.description.length > 150 ? '...' : ''}</p>` : ''}
            `;
      listItem.addEventListener('click', (e) => {
        if (
          e.target.closest('.duplicate-workout-btn') ||
          e.target.closest('.edit-workout-btn')
        )
          return;
        showWorkoutDetails(plan.id);
      });

      // === ОНОВЛЕНИЙ БЛОК: Кнопки "Дублювати" або "Редагувати" ===
      if (currentUserProfileData?.is_independent) {
        if (plan.completed) {
          // Якщо тренування виконане, показуємо кнопку "Дублювати"
          const duplicateBtn = document.createElement('button');
          duplicateBtn.className = 'duplicate-workout-btn';
          duplicateBtn.title = 'Дублювати тренування';
          duplicateBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path></svg>`;
          duplicateBtn.addEventListener('click', () =>
            handleDuplicateWorkout(plan.id)
          );
          listItem.appendChild(duplicateBtn);
        } else {
          // Якщо тренування ще НЕ виконане, показуємо кнопку "Редагувати"
          const editBtn = document.createElement('button');
          editBtn.className = 'edit-workout-btn';
          editBtn.title = 'Редагувати тренування';
          editBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"></path></svg>`;
          editBtn.addEventListener('click', () => handleEditWorkout(plan.id));
          listItem.appendChild(editBtn);
        }
      }
      // ========================================================

      workoutListContainer.appendChild(listItem);
    });

    // ... (код для кнопки "Завантажити ще" залишається без змін) ...
    const totalDisplayed = workoutListContainer.children.length;
    if (totalDisplayed < totalUserWorkoutsAvailable) {
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.textContent = `Завантажити ще ${WORKOUTS_PER_PAGE_MORE} тренувань`;
      loadMoreBtn.className = 'load-more-btn';
      loadMoreBtn.onclick = () => loadWorkoutList(true);
      loadMoreContainer.appendChild(loadMoreBtn);
    } else if (totalUserWorkoutsAvailable > 0) {
      loadMoreContainer.innerHTML = `<p class="all-items-loaded-message">Всі ${totalUserWorkoutsAvailable} тренувань завантажено.</p>`;
    }
  } catch (error) {
    if (!error.message.includes('потрібна активна підписка')) {
      displayStatus('workout-list-status', `Помилка: ${error.message}`, true);
    }
  } finally {
    isLoadingMoreUserWorkouts = false;
    slowConnectionDetector.stop();
    if (statusDiv.innerText === 'Завантаження тренувань...') {
      displayStatus('workout-list-status', '');
    }
  }
} // Кінець функції loadWorkoutList

/**
 * Генерує READ-ONLY таблицю для користувача, показуючи ПЛАН та ФАКТ.
 * Динамічно приховує стовпці, якщо для них немає жодних значущих даних.
 * @param {Array<number|null>} plannedReps
 * @param {Array<number|null>} plannedWeights
 * @param {Array<number|null>} plannedTime
 * @param {Array<number|null>} completedReps
 * @param {Array<number|null>} completedWeights
 * @param {Array<number|null>} completedTime
 * @returns {string} HTML рядок таблиці.
 */
function generateUserReadOnlyTableHTML(
  plannedReps,
  plannedWeights,
  plannedTime,
  completedReps,
  completedWeights,
  completedTime
) {
  plannedReps = plannedReps || [];
  plannedWeights = plannedWeights || [];
  plannedTime = plannedTime || [];
  completedReps = completedReps || [];
  completedWeights = completedWeights || [];
  completedTime = completedTime || [];

  const numRows = Math.max(
    plannedReps.length,
    plannedWeights.length,
    plannedTime.length,
    completedReps.length,
    completedWeights.length,
    completedTime.length
  );

  if (numRows === 0) {
    return '<p style="font-style: italic; color: #aaa;">Дані про виконання відсутні.</p>';
  }

  const hasAnyData = (arrValues) =>
    Array.isArray(arrValues) &&
    arrValues.some((val) => val !== null && val !== undefined);

  const showRepsColumns = hasAnyData(plannedReps) || hasAnyData(completedReps);
  const showWeightsColumns =
    hasAnyData(plannedWeights) || hasAnyData(completedWeights);
  const showTimeColumns = hasAnyData(plannedTime) || hasAnyData(completedTime);

  if (!showRepsColumns && !showWeightsColumns && !showTimeColumns) {
    return `<p>Підходів: ${numRows}.<br>Деталі по повтореннях, вазі та часу не вказані.</p>`;
  }

  let tableHeaderHTML = '<th>Підхід</th>';
  if (showRepsColumns) {
    tableHeaderHTML +=
      '<th>Повт. (план)</th><th class="user-fact-col">Повт. (факт)</th>';
  }
  if (showWeightsColumns) {
    tableHeaderHTML +=
      '<th>Вага (план)</th><th class="user-fact-col">Вага (факт)</th>';
  }
  if (showTimeColumns) {
    tableHeaderHTML +=
      '<th>Час (план)</th><th class="user-fact-col">Час (факт)</th>';
  }

  let tableHTML = `<table class="exercise-sets-table readonly user-completed">
                        <thead><tr>${tableHeaderHTML}</tr></thead>
                        <tbody>`;

  for (let i = 0; i < numRows; i++) {
    const setNumber = i + 1;
    let rowContentHTML = `<td>${setNumber}</td>`;

    if (showRepsColumns) {
      const planRepValue = plannedReps[i];
      const factRepValue = completedReps[i];
      const planRepDisplay =
        planRepValue !== null && planRepValue !== undefined
          ? planRepValue
          : '--';
      const factRepDisplay =
        factRepValue !== null && factRepValue !== undefined
          ? factRepValue
          : '--';
      rowContentHTML += `<td>${planRepDisplay}</td><td class="user-fact-val">${factRepDisplay}</td>`;
    }

    if (showWeightsColumns) {
      const planWeightValue = plannedWeights[i];
      const factWeightValue = completedWeights[i];

      // ФОРМУЄМО РЯДОК ДЛЯ ВІДОБРАЖЕННЯ ПЛАНОВОЇ ВАГИ З ОДИНИЦЯМИ "кг"
      const planWeightDisplay =
        planWeightValue !== null && planWeightValue !== undefined
          ? `${planWeightValue} кг` // Додаємо " кг"
          : '--';

      // ФОРМУЄМО РЯДОК ДЛЯ ВІДОБРАЖЕННЯ ФАКТИЧНОЇ ВАГИ З ОДИНИЦЯМИ "кг"
      const factWeightDisplay =
        factWeightValue !== null && factWeightValue !== undefined
          ? `${factWeightValue} кг` // Додаємо " кг"
          : '--';

      rowContentHTML += `<td>${planWeightDisplay}</td><td class="user-fact-val">${factWeightDisplay}</td>`;
    }

    if (showTimeColumns) {
      const planTimeValue = plannedTime[i];
      const factTimeValue = completedTime[i];
      const planTimeDisplay =
        planTimeValue !== null && planTimeValue !== undefined
          ? `${planTimeValue} сек`
          : '--';
      const factTimeDisplay =
        factTimeValue !== null && factTimeValue !== undefined
          ? `${factTimeValue} сек`
          : '--';
      rowContentHTML += `<td>${planTimeDisplay}</td><td class="user-fact-val">${factTimeDisplay}</td>`;
    }

    tableHTML += `<tr>${rowContentHTML}</tr>`;
  }

  tableHTML += `</tbody></table>`;
  return `<div class="table-scroll-wrapper">${tableHTML}</div>`;
}

/**
 * ОНОВЛЕНО: Тепер ця функція відповідає ТІЛЬКИ за відображення даних.
 * Вся логіка рендерингу перенесена сюди з showWorkoutDetails.
 * @param {object} plan - Повний об'єкт тренування для відображення.
 */
function renderWorkoutDetailsFromData(plan) {
  const detailsContainer = document.getElementById('workout-details-container');
  const exercisesContainer = document.getElementById(
    'workout-details-exercises'
  );
  const detailsTitle = document.getElementById('workout-details-title');
  const detailsDate = document.getElementById('workout-details-date');
  const detailsDesc = document.getElementById('workout-details-description');

  if (
    !detailsContainer ||
    !exercisesContainer ||
    !detailsTitle ||
    !detailsDate ||
    !detailsDesc
  ) {
    console.error(
      'Критична помилка: Не знайдено основні контейнери для деталей тренування.'
    );
    return;
  }

  detailsContainer.dataset.currentPlanId = plan.id;
  displayStatus('workout-details-status', '', false);
  exercisesContainer.innerHTML = '';
  const feedbackSection = document.getElementById('feedback-section');
  if (feedbackSection) feedbackSection.innerHTML = '';

  detailsTitle.innerHTML = plan.title || 'Назви тренування немає =(';
  detailsDate.innerHTML = new Date(plan.date).toLocaleDateString('uk-UA');
  detailsDesc.innerHTML =
    formatTextWithLineBreaks(plan.description) ||
    'Загальний опис до тренування відсутній...';

  renderFeedbackSection(plan);

  const completedExercisesDataKey = `completedPlan_${plan.id}`;
  const completedExercisesMap =
    JSON.parse(localStorage.getItem(completedExercisesDataKey)) || {};

  if (
    plan.exercises &&
    Array.isArray(plan.exercises) &&
    plan.exercises.length > 0
  ) {
    let userExcludedGifNamesCurrent = [];
    if (
      currentUserProfileData &&
      Array.isArray(currentUserProfileData.excluded_exercises)
    ) {
      userExcludedGifNamesCurrent = currentUserProfileData.excluded_exercises;
    }

    // --- ВИПРАВЛЕНО: Змінну потрібно оголосити тут ---
    let planContainsExcludedExerciseInitially = false;

    plan.exercises
      .sort((a, b) => a.order - b.order)
      .forEach((exercise) => {
        //
        // --- ПОЧАТОК ПОВНОГО ТА ВИПРАВЛЕНОГО КОДУ ДЛЯ РЕНДЕРИНГУ ВПРАВИ ---
        //
        const exerciseId = exercise.id;
        const gifId = exercise.gif.id;
        const gifName = exercise.gif.name ? exercise.gif.name.trim() : null;

        // --- ВИПРАВЛЕНО: 'const exerciseDiv' оголошується тільки ОДИН РАЗ ---
        const exerciseDiv = document.createElement('div');
        exerciseDiv.classList.add('exercise-item');
        exerciseDiv.setAttribute('data-exercise-id', exerciseId);
        exerciseDiv.setAttribute('data-gif-id', gifId);
        if (gifName) {
          exerciseDiv.setAttribute('data-gif-name', gifName);
        }

        const isCompleted = !!completedExercisesMap[exerciseId];
        if (isCompleted) {
          exerciseDiv.classList.add('exercise-completed-visual');
        }

        const isEffectivelyExcluded =
          exercise.is_excluded_by_user === true ||
          (gifName && userExcludedGifNamesCurrent.includes(gifName));
        if (isEffectivelyExcluded) {
          exerciseDiv.classList.add('exercise-excluded-by-user');
          planContainsExcludedExerciseInitially = true;
        }

        const headerDiv = document.createElement('div');
        headerDiv.classList.add('exercise-header');

        const orderSpan = document.createElement('span');
        orderSpan.className = 'exercise-order';
        orderSpan.textContent = `${exercise.order}.`;
        headerDiv.appendChild(orderSpan);

        const nameH5 = document.createElement('h5');
        nameH5.className = 'exercise-name';
        nameH5.textContent = gifName || 'Назва вправи відсутня';
        headerDiv.appendChild(nameH5);

        if (gifName && !isEffectivelyExcluded) {
          const excludeButton = document.createElement('button');
          excludeButton.className = 'exclude-exercise-btn';
          excludeButton.title = 'Виключити цю вправу з майбутніх планів';
          excludeButton.innerHTML = '&times;';
          headerDiv.appendChild(excludeButton);
        }

        if (isCompleted) {
          const checkmarkSpan = document.createElement('span');
          checkmarkSpan.className = 'exercise-checkmark';
          checkmarkSpan.title = 'Вправу виконано';
          checkmarkSpan.textContent = ' ✔️';
          headerDiv.appendChild(checkmarkSpan);
        }
        exerciseDiv.appendChild(headerDiv);

        const mediaContainer = document.createElement('div');
        mediaContainer.classList.add('exercise-media-container');

        const exerciseGif = exercise.gif;
        let pngPreviewUrl = '';
        let gifUrl = '';
        const baseStaticServerUrl = 'https://limaxsport.top/static/gifs/';

        if (
          exerciseGif &&
          typeof exerciseGif.filename === 'string' &&
          exerciseGif.filename.trim() !== ''
        ) {
          const relativePathWithExtension = exerciseGif.filename.trim();
          gifUrl = `${baseStaticServerUrl}${relativePathWithExtension}`;
          let baseRelativePath = relativePathWithExtension;
          const lastDotIndex = baseRelativePath.lastIndexOf('.');
          if (lastDotIndex !== -1) {
            baseRelativePath = baseRelativePath.substring(0, lastDotIndex);
          }
          pngPreviewUrl = `${baseStaticServerUrl}${baseRelativePath}.png`;
        }

        const pngImg = document.createElement('img');
        if (pngPreviewUrl) {
          pngImg.src = pngPreviewUrl;
        }
        pngImg.alt = `Прев'ю: ${exerciseGif ? exerciseGif.name || 'вправа' : 'вправа'}`;
        pngImg.classList.add('exercise-preview-png');

        const loaderDiv = document.createElement('div'); // Потрібно визначити loaderDiv тут
        loaderDiv.classList.add('exercise-loader');
        loaderDiv.style.display = 'none';

        pngImg.onerror = () => {
          pngImg.style.display = 'none';
          if (!mediaContainer.querySelector('.preview-error-message')) {
            const errorP = document.createElement('p');
            errorP.textContent = "Прев'ю тимчасово недоступне";
            errorP.classList.add(
              'preview-error-message',
              'media-error-message'
            );
            mediaContainer.insertBefore(errorP, loaderDiv);
          }
        };
        mediaContainer.appendChild(pngImg);
        mediaContainer.appendChild(loaderDiv);

        const slowLoadMessageDiv = document.createElement('div');
        slowLoadMessageDiv.classList.add('exercise-slow-load-message');
        slowLoadMessageDiv.textContent =
          "Поганий інтернет зв'язок, іде завантаження анімації вправи";
        slowLoadMessageDiv.style.display = 'none';
        mediaContainer.appendChild(slowLoadMessageDiv);

        const gifImg = document.createElement('img');
        if (gifUrl) {
          gifImg.alt = exerciseGif
            ? exerciseGif.name || 'Анімація вправи'
            : 'Анімація вправи';
          gifImg.classList.add('exercise-gif');
          gifImg.style.display = 'none';
          mediaContainer.appendChild(gifImg);
          loaderDiv.style.display = 'block';

          let slowLoadTimer = setTimeout(() => {
            if (
              gifImg.style.display === 'none' &&
              !gifImg.dataset.loadError &&
              gifImg.src
            ) {
              slowLoadMessageDiv.style.display = 'block';
            }
          }, 10000);

          gifImg.onload = () => {
            clearTimeout(slowLoadTimer);
            if (pngImg.style.display !== 'none') {
              pngImg.style.display = 'none';
              const previewErrorMsg = mediaContainer.querySelector(
                '.preview-error-message'
              );
              if (previewErrorMsg) previewErrorMsg.remove();
            }
            loaderDiv.style.display = 'none';
            slowLoadMessageDiv.style.display = 'none';
            gifImg.style.display = 'block';
            gifImg.dataset.loaded = 'true';
          };

          gifImg.onerror = () => {
            clearTimeout(slowLoadTimer);
            loaderDiv.style.display = 'none';
            slowLoadMessageDiv.textContent = 'Не вдалося завантажити анімацію.';
            slowLoadMessageDiv.style.display = 'block';
            gifImg.dataset.loadError = 'true';
          };

          gifImg.src = gifUrl;
        } else {
          loaderDiv.style.display = 'none';
          if (
            pngImg.style.display === 'none' &&
            !mediaContainer.querySelector('.preview-error-message')
          ) {
            if (!mediaContainer.querySelector('.no-media-message')) {
              const noMediaP = document.createElement('p');
              noMediaP.textContent = 'Медіа для вправи відсутнє';
              noMediaP.classList.add('no-media-message');
              noMediaP.style.cssText =
                'color: #888; font-size: 0.8em; text-align: center;';
              mediaContainer.insertBefore(noMediaP, loaderDiv);
            }
          }
        }
        exerciseDiv.appendChild(mediaContainer);

        const detailsContentDiv = document.createElement('div');
        detailsContentDiv.classList.add('exercise-details-content');

        const techniqueToggle = document.createElement('div');
        techniqueToggle.className = 'technique-toggle';
        techniqueToggle.innerHTML = `<span>Техніка виконання вправи</span><span class="toggle-arrow">▼</span>`;

        const techniqueContent = document.createElement('div');
        techniqueContent.className = 'technique-content';

        const descriptionText = document.createElement('div');
        descriptionText.className = 'description-text';
        descriptionText.innerHTML =
          formatTextWithLineBreaks(exercise.gif.description) ||
          'Опис відсутній.';

        techniqueContent.appendChild(descriptionText);

        techniqueToggle.addEventListener('click', () => {
          techniqueToggle.classList.toggle('active');
          techniqueContent.classList.toggle('expanded');
        });

        detailsContentDiv.appendChild(techniqueToggle);
        detailsContentDiv.appendChild(techniqueContent);

        if (exercise.all_weight) {
          const p = document.createElement('p');
          p.innerHTML = `<strong>Загальна робоча вага:</strong> <span class="exercise-all-weight">${exercise.all_weight}</span>`;
          detailsContentDiv.appendChild(p);
        }
        if (exercise.weight_range) {
          const p = document.createElement('p');
          p.innerHTML = `<strong>Діапазон робочих ваг:</strong> <span class="exercise-weight-range">${exercise.weight_range}</span>`;
          detailsContentDiv.appendChild(p);
        }
        if (exercise.emphasis) {
          const span = document.createElement('span');
          span.className = 'exercise-emphasis';
          span.innerHTML = '<strong>Акцент на цій вправі!</strong>';
          detailsContentDiv.appendChild(span);
        }
        if (exercise.superset) {
          const span = document.createElement('span');
          span.className = 'exercise-superset';
          span.innerHTML =
            '<strong>Виконувати в суперсеті з наступною вправою ⇓</strong>';
          detailsContentDiv.appendChild(span);
        }

        const executionTitle = document.createElement('h6');
        executionTitle.innerHTML = `<strong>Виконання вправи:</strong> ${!isCompleted ? '<em style="font-size:0.8em; color: #aaa;">(клікни на повторення або вагу, щоб змінити)</em>' : ''}`;
        detailsContentDiv.appendChild(executionTitle);

        exerciseDiv.dataset.plannedReps = JSON.stringify(exercise.reps || []);
        exerciseDiv.dataset.plannedWeights = JSON.stringify(
          exercise.weights || []
        );
        exerciseDiv.dataset.plannedTime = JSON.stringify(exercise.time || []);

        // --- ЗМІНІТЬ ЦЮ ЛОГІКУ: Тепер ми беремо ОРИГІНАЛЬНІ дані ---
        const originalExercise = originalPlanDataForDetails.exercises.find(
          (ex) => ex.id === exercise.id
        );
        const originalSetCount = originalExercise
          ? Math.max(
              originalExercise.reps?.length || 0,
              originalExercise.weights?.length || 0,
              originalExercise.time?.length || 0
            )
          : 0;

        const setsTableContainer = document.createElement('div');
        setsTableContainer.classList.add('sets-table-container');

        if (isCompleted) {
          const completedData = completedExercisesMap[exerciseId];
          setsTableContainer.innerHTML = generateUserReadOnlyTableHTML(
            completedData.plannedReps || exercise.reps || [],
            completedData.plannedWeights || exercise.weights || [],
            completedData.plannedTime || exercise.time || [],
            completedData.completedReps,
            completedData.completedWeights,
            completedData.completedTime || []
          );
        } else {
          // --- ЗМІНІТЬ ЦЕЙ РЯДОК: Додаємо четвертий аргумент 'isCompleted' ---
          setsTableContainer.innerHTML = generateEditableSetsTableHTML(
            exercise,
            plan.id,
            originalSetCount,
            isCompleted
          );
        }
        detailsContentDiv.appendChild(setsTableContainer);

        if (exercise.total_weight === true) {
          const span = document.createElement('span');
          span.className = 'total-weight-text';
          span.innerHTML = '⇑ загальна вага для 2-х гантелей/кросоверів ⇑';
          detailsContentDiv.appendChild(span);
        }
        if (exercise.total_reps === true) {
          const span = document.createElement('span');
          span.className = 'total-reps-text';
          span.innerHTML = '⇑ загальна кількість повторень для обох ніг/рук ⇑';
          detailsContentDiv.appendChild(span);
        }

        if (
          Array.isArray(exercise.time) &&
          exercise.time.some((t) => t !== null && t > 0)
        ) {
          const startWorkBtn = document.createElement('button');
          startWorkBtn.className = 'rest-timer-button';
          startWorkBtn.innerHTML = `
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zm0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8z"></path><path d="M13 7h-2v5.414l3.293 3.293 1.414-1.414L13 11.586z"></path></svg>
                          <span>Виконувати вправу з таймером</span>
                      `;

          addSafeEventListener(startWorkBtn, async () => {
            unlockAudioContext();
            openRestTimerModal();

            if (!areSoundsLoaded) {
              // ОНОВЛЕНО: Встановлюємо текст напряму, не змінюючи колір
              timerStatusText.textContent = 'Завантаження звуків...';
              await initAudio();
            }
            if (!areSoundsLoaded) {
              // Якщо завантаження провалилось, повертаємо стандартний текст
              timerStatusText.textContent = 'ВІДПОЧИНОК';
              return;
            }

            const workDurations = exercise.time.filter(
              (t) => t !== null && t > 0
            );
            const restDuration = exercise.rest_time || 0;
            startWorkAndRestSequence(workDurations, restDuration);
          });
          detailsContentDiv.appendChild(startWorkBtn);

          if (exercise.rest_time && exercise.rest_time > 0) {
            const staticRestText = document.createElement('p');
            staticRestText.className = 'static-rest-time';
            staticRestText.innerHTML = `<strong>Відпочинок:</strong> ${formatSecondsToMMSS(exercise.rest_time)}`;
            detailsContentDiv.appendChild(staticRestText);
          }
        } else if (exercise.rest_time && exercise.rest_time > 0) {
          const restButton = document.createElement('button');
          restButton.className = 'rest-timer-button';
          restButton.title = 'Натисніть, щоб запустити таймер відпочинку';
          restButton.innerHTML = `
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zm0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8z"></path><path d="M13 7h-2v5.414l3.293 3.293 1.414-1.414L13 11.586z"></path></svg>
                              <span>Відпочинок: ${formatSecondsToMMSS(exercise.rest_time)}</span>
                          `;

          addSafeEventListener(restButton, async () => {
            unlockAudioContext();
            openRestTimerModal();

            if (!areSoundsLoaded) {
              // ОНОВЛЕНО: Встановлюємо текст напряму, не змінюючи колір
              timerStatusText.textContent = 'Завантаження звуків...';
              await initAudio();
            }
            if (!areSoundsLoaded) {
              timerStatusText.textContent = 'ВІДПОЧИНОК';
              return;
            }

            startSimpleRestTimer(exercise.rest_time);
          });
          detailsContentDiv.appendChild(restButton);
        }

        if (!isCompleted) {
          const saveAreaContainer = document.createElement('div');
          saveAreaContainer.classList.add('save-preference-area');
          const infoTextSpan = document.createElement('span');
          infoTextSpan.classList.add('save-preference-info');
          infoTextSpan.textContent = 'Виконав вправу - тисни блискавку:';
          const saveButton = document.createElement('button');
          saveButton.type = 'button';
          saveButton.classList.add('save-preference-btn', 'icon-btn');
          saveButton.dataset.gifId = exercise.gif.id;
          saveButton.textContent = '⚡️';
          saveButton.title = 'Позначити вправу виконаною та зберегти показники';
          saveButton.addEventListener('click', handleSavePreferenceClick);

          saveAreaContainer.appendChild(infoTextSpan);
          saveAreaContainer.appendChild(saveButton);
          detailsContentDiv.appendChild(saveAreaContainer);
        }

        exerciseDiv.appendChild(detailsContentDiv);

        if (!isCompleted) {
          addEditListenersToExercise(exerciseDiv);
        }

        exercisesContainer.appendChild(exerciseDiv);
        //
        // --- КІНЕЦЬ ПОВНОГО КОДУ РЕНДЕРИНГУ ---
        //
      });

    // +++ ДОДАЙТЕ ЦЕЙ РЯДОК, ЩОБ ВИКОРИСТАТИ ЗМІННУ +++
    updateWorkoutListItemAppearance(
      plan.id,
      planContainsExcludedExerciseInitially
    );

    // Ініціалізуємо обробники для нових кнопок "+/-"
    const addSetButtons = exercisesContainer.querySelectorAll('.add-set-btn');
    addSetButtons.forEach((btn) =>
      btn.addEventListener('click', handleAddSetClick)
    );

    const removeSetButtons =
      exercisesContainer.querySelectorAll('.remove-set-btn');
    removeSetButtons.forEach((btn) =>
      btn.addEventListener('click', handleRemoveLastSetClick)
    );

    initializeExcludeExerciseButtons(plan.id, userExcludedGifNamesCurrent);

    // Фонове завантаження решти GIF
    plan.exercises.forEach((exercise) => {
      if (exercise.order > 1 && exercise.gif && exercise.gif.filename) {
        const subsequentGifUrl = `https://limaxsport.top/static/gifs/${exercise.gif.filename}`;
        const imgPreloader = new Image();
        imgPreloader.src = subsequentGifUrl;
      }
    });
  } else {
    exercisesContainer.innerHTML =
      '<p>Вправи для цього тренування ще не додані.</p>';
  }

  // --- ДОДАНО: Повний блок для кнопки завершення тренування ---
  const completionDiv = document.createElement('div');
  completionDiv.id = 'completion-section';
  completionDiv.style.marginTop = '25px';
  completionDiv.style.paddingTop = '15px';
  completionDiv.style.borderTop = '1px dashed rgb(113, 41, 218)';
  const isCompletedPlan = plan.completed;
  completionDiv.innerHTML = `
        <button id="complete-workout-button" class="${isCompletedPlan ? 'completed' : 'not-completed'}" data-plan-id="${plan.id}">
            ${isCompletedPlan ? '✔ Виконано' : 'Позначити тренування виконаним'}
        </button>
        <div id="greeting-text" style="display: ${isCompletedPlan ? 'block' : 'none'}; margin-top: 10px; color: lightgreen; text-align: center;">
            <h6><strong>Тренування зараховано, тепер ви на крок ближче до своєї мети! 💪</strong></h6>
        </div>
        <div id="uncompleted-warning-text" style="display: ${isCompletedPlan ? 'none' : 'block'}; margin-top: 10px; color: #dc3545; text-align: center; font-size: 0.9em; font-style: italic;">
            Натисніть, щоб підтвердити виконання. Непідтверджені тренування зараховуються як пропущені. ⚠️
        </div>
        <div id="completion-status" style="min-height: 1em; margin-top: 5px; text-align: center;"></div>
    `;
  exercisesContainer.appendChild(completionDiv);

  const completeButton = completionDiv.querySelector(
    '#complete-workout-button'
  );
  if (completeButton) {
    completeButton.addEventListener('click', async () => {
      const currentStatus = completeButton.classList.contains('completed');
      const newStatus = !currentStatus; // Інвертуємо статус для відправки
      const planIdToUpdate = completeButton.dataset.planId;
      const statusElementId = 'completion-status'; // ID для повідомлень статусу

      try {
        // Використовуємо fetchWithAuth для PATCH запиту
        const { data: updatedPlan, response: patchResponse } =
          await fetchWithAuth(
            `${baseURL}/training_plans/${planIdToUpdate}/status`,
            {
              method: 'PATCH',
              body: JSON.stringify({
                completed: newStatus,
              }),
            }
          );

        if (!patchResponse.ok) {
          // ВИПРАВЛЕНО: Використовуємо 'updatedPlan' для деталей помилки, а не 'errorData'
          throw new Error(
            updatedPlan.detail || `Помилка сервера: ${patchResponse.status}`
          );
        }

        // +++ ДОДАЙТЕ ЦЕЙ РЯДОК: Очищуємо пам'ять, якщо тренування ВИКОНАНО +++
        if (newStatus === true) {
          clearInProgressWorkoutData(planIdToUpdate);
        }

        // Оновлюємо UI на основі відповіді сервера
        completeButton.textContent = updatedPlan.completed
          ? '✔ Виконано'
          : 'Позначити тренування виконаним';
        completeButton.classList.toggle('completed', updatedPlan.completed);
        completeButton.classList.toggle(
          'not-completed',
          !updatedPlan.completed
        );

        // Керуємо видимістю ОБОХ текстових повідомлень
        const greetingTextDiv = document.getElementById('greeting-text');
        const warningTextDiv = document.getElementById(
          'uncompleted-warning-text'
        );

        if (greetingTextDiv) {
          greetingTextDiv.style.display = updatedPlan.completed
            ? 'block'
            : 'none';
        }
        if (warningTextDiv) {
          warningTextDiv.style.display = updatedPlan.completed
            ? 'none'
            : 'block';
        }

        // --- ОНОВЛЕННЯ ЕЛЕМЕНТА У СПИСКУ ---
        const listItemInList = document.querySelector(
          `.workout-list-item[data-plan-id="${planIdToUpdate}"]`
        );
        if (listItemInList) {
          // Додаємо/видаляємо клас 'completed'
          listItemInList.classList.toggle('completed', updatedPlan.completed);

          // Додаємо/видаляємо індикатор (галочку)
          let indicator = listItemInList.querySelector('.completion-indicator');
          if (updatedPlan.completed && !indicator) {
            indicator = document.createElement('span');
            indicator.className = 'completion-indicator';
            indicator.textContent = '✔';
            listItemInList.prepend(indicator);
          } else if (!updatedPlan.completed && indicator) {
            indicator.remove();
          }
        } else {
          console.warn(
            `Елемент списку для плану ${planIdToUpdate} не знайдено для оновлення.`
          );
        }
      } catch (error) {
        console.error('Помилка оновлення статусу тренування:', error);
        if (typeof displayStatus === 'function') {
          displayStatus(
            statusElementId,
            `Помилка: ${error.message}`,
            true,
            5000
          );
        } else {
          alert(`Помилка оновлення статусу: ${error.message}`);
        }
      }
    });
  }
}

/**
 * ОНОВЛЕНО: Тепер ця функція ТІЛЬКИ завантажує дані та викликає рендерер.
 */
async function showWorkoutDetails(planId) {
  const listContainer = document.getElementById('workout-list-container');
  const detailsContainer = document.getElementById('workout-details-container');
  const detailsStatusDiv = document.getElementById('workout-details-status');

  if (!detailsContainer || !listContainer || !detailsStatusDiv) return;

  listContainer.style.display = 'none';
  detailsContainer.style.display = 'block';

  displayStatus(
    'workout-details-status',
    'Завантаження деталей тренування...',
    false
  );
  slowConnectionDetector.start('workout-details-status');

  try {
    // 1. Завантажуємо план і профіль одночасно, як у тебе і було
    const [planResult, profileResult] = await Promise.all([
      fetchWithAuth(`${baseURL}/training_plans/${planId}`),
      fetchCurrentProfileDataOnce(),
    ]);

    const { data: plan, response: planResponse } = planResult;
    currentUserProfileData = profileResult; // Зберігаємо профіль

    if (!planResponse.ok) {
      throw new Error(plan.detail || `Помилка сервера: ${planResponse.status}`);
    }

    // 2. Зберігаємо ОРИГІНАЛ для порівняння
    originalPlanDataForDetails = JSON.parse(JSON.stringify(plan));

    // 3. Отримуємо збережені зміни САМЕ ДЛЯ ЦЬОГО ТРЕНУВАННЯ з localStorage
    const inProgressKey = `inProgressPlan_${planId}`;
    const savedProgress = JSON.parse(localStorage.getItem(inProgressKey)) || {};

    // 4. "Змішуємо" планові дані зі збереженими змінами
    plan.exercises.forEach((exercise) => {
      if (savedProgress[exercise.id]) {
        const savedData = savedProgress[exercise.id];
        // Застосовуємо збережені показники поверх планових
        exercise.reps = savedData.reps;
        exercise.weights = savedData.weights;
        exercise.time = savedData.time;
        exercise.sets = savedData.sets; // Важливо також оновити кількість підходів
      }
    });

    // 5. Викликаємо рендер з уже правильними даними
    renderWorkoutDetailsFromData(plan);
  } catch (error) {
    console.error('Помилка завантаження деталей тренування:', error);
    detailsContainer.innerHTML = `<p>Не вдалося завантажити деталі тренування: ${error.message}</p><button id="back-to-workout-list-error" class="btn-secondary">Назад до списку</button>`;
    const backBtnError = document.getElementById('back-to-workout-list-error');
    if (backBtnError) {
      backBtnError.addEventListener('click', () => {
        detailsContainer.style.display = 'none';
        listContainer.style.display = 'block';
      });
    }
  } finally {
    slowConnectionDetector.stop();
  }
}

// --- БЛОК КОДУ АНАЛІЗУ ФІДБЕКУ від GEMINI ---
/**
 * ОНОВЛЕНО: Відправляє фідбек, запускає AI-аналіз у фоні та починає перевірку результату.
 */
async function handleFeedbackAndAIAnalysis(event) {
  const button = event.currentTarget;
  const planId = button.dataset.planId;
  const feedbackStatusDiv = document.getElementById('feedback-status');
  const actionContainer = document.querySelector('.feedback-action-container');

  if (!planId || !feedbackStatusDiv || !actionContainer) {
    alert('Критична помилка: не вдалося знайти необхідні елементи.');
    return;
  }

  const feedbackData = {
    training_duration:
      parseInt(document.getElementById('workout-feedback-duration')?.value) ||
      null,
    cardio_duration:
      parseInt(document.getElementById('workout-feedback-cardio')?.value) ||
      null,
    calories_burned:
      parseInt(document.getElementById('workout-feedback-calories')?.value) ||
      null,
    difficulty:
      document.getElementById('workout-feedback-difficulty')?.value || null,
    feedback: document.getElementById('workout-feedback')?.value.trim() || null,
  };

  // Одразу вимикаємо UI
  button.disabled = true;
  button.style.display = 'none'; // Ховаємо кнопку
  displayStatus(
    feedbackStatusDiv.id,
    'Ваш відгук збережено. Запускаємо аналіз від Gemini... Це може зайняти до хвилини.',
    false
  );

  // Створюємо контейнер для спіннера, якщо його немає
  let loader = actionContainer.querySelector('.gemini-spinner');
  if (!loader) {
    loader = document.createElement('div');
    loader.className = 'gemini-spinner';
    actionContainer.appendChild(loader);
  }
  loader.style.display = 'block';

  try {
    // Крок 1: Зберігаємо фідбек (це швидка операція)
    await fetchWithAuth(`${baseURL}/training_plans/${planId}/feedback`, {
      method: 'POST',
      body: JSON.stringify(feedbackData),
    });

    // Крок 2: Відправляємо запит на аналіз і ЧЕКАЄМО на відповідь, щоб обробити помилки
    const { data: aiResponseData, response: aiResponse } = await fetchWithAuth(
      `${baseURL}/training_plans/${planId}/ai-feedback`,
      {
        method: 'POST',
      }
    );

    // Якщо відповідь не успішна, викидаємо помилку
    if (!aiResponse.ok) {
      const error = new Error(
        aiResponseData.detail || `Помилка сервера: ${aiResponse.status}`
      );
      error.status = aiResponse.status; // Додаємо статус до об'єкта помилки
      throw error;
    }

    // Крок 3: Запускаємо перевірку результату у фоні (тільки якщо запит на аналіз був успішним)
    startPollingForAIAnalysis(planId);
  } catch (error) {
    // Обробляємо помилки як від збереження фідбеку, так і від запуску аналізу
    console.error(
      'Помилка під час відправки фідбеку або запуску аналізу:',
      error
    );
    displayStatus(
      feedbackStatusDiv.id,
      `Помилка: ${error.message}`,
      true,
      10000
    );

    // Якщо помилка 429, то кнопка залишається прихованою.
    // Для інших помилок - повертаємо її.
    if (error.status === 429) {
      // Показуємо користувачу повідомлення про денний ліміт
      displayStatus(
        feedbackStatusDiv.id,
        'Ви вже отримали аналіз сьогодні. Новий аналіз буде доступний для наступного тренування завтра.',
        true, // Показуємо як помилку (червоним кольором)
        10000 // Повідомлення зникне через 10 секунд
      );
      // Кнопка "Надіслати" залишається прихованою, що є правильною поведінкою.
    } else {
      // Для всіх інших помилок показуємо стандартне повідомлення
      displayStatus(
        feedbackStatusDiv.id,
        `Помилка: ${error.message}`,
        true,
        10000
      );
      // І повертаємо кнопку, щоб користувач міг спробувати ще раз
      button.disabled = false;
      button.style.display = 'inline-flex';
    }
    // --- КІНЕЦЬ ЗМІН ---

    if (loader) loader.style.display = 'none';
  }
}

/**
 * ОНОВЛЕНО: Додано перемикач для стислого аналізу.
 * Рендерить секцію фідбеку залежно від того, чи є вже аналіз від ШІ.
 * @param {object} plan - Об'єкт тренування з бекенду.
 */
function renderFeedbackSection(plan) {
  const feedbackSectionContainer = document.getElementById('feedback-section');
  if (!feedbackSectionContainer) return;

  // Перевіряємо поточне налаштування користувача з кешу
  const isConcisePreferred =
    currentUserProfileData?.prefers_concise_analysis === true;

  // HTML для самого перемикача
  const toggleHTML = `
        <div class="concise-toggle-container">
            <label class="switch">
                <input type="checkbox" id="concise-analysis-toggle" ${isConcisePreferred ? 'checked' : ''}>
                <span class="slider round"></span>
            </label>
            <label for="concise-analysis-toggle" class="toggle-label">Хочу отримувати стислий аналіз</label>
        </div>
    `;

  let contentHTML = '';

  // ВИПАДОК 1: Аналіз вже є, показуємо все в режимі "тільки читання"
  if (plan.ai_feedback_analysis) {
    contentHTML = `
            <div class="feedback-ai-analysis-container">
                <h4>Підсумок та аналіз тренування</h4>
                <div class="feedback-readonly-view">
                    </div>
                ${toggleHTML} <div id="ai-analysis-result-container">
                    <h5>Аналіз тренування від Gemini</h5>
                    <div class="ai-analysis-text">${plan.ai_feedback_analysis}</div>
                </div>
            </div>
        `;
  }
  // ВИПАДОК 2: Аналізу ще немає, показуємо форму для заповнення
  else {
    contentHTML = `
            <div class="feedback-ai-analysis-container">
                <h4>Фідбек та аналіз тренування</h4>
                <div class="feedback-action-container">
                    <button id="submit-feedback-and-analyze-btn" class="gemini-btn" data-plan-id="${plan.id}">
                        Надіслати та отримати аналіз ✨
                    </button>
                    <div id="feedback-status" class="status-message"></div>
                </div>
                ${toggleHTML} <div id="ai-analysis-result-container"></div>
            </div>
        `;
  }

  // Вставляємо згенерований HTML (тут ми можемо просто об'єднати, бо структура майже однакова)
  // Щоб не дублювати код, ось фінальний варіант:
  const readonlyFeedbackHTML = `
         <div class="feedback-readonly-view">
            <div class="feedback-item"><span class="feedback-label">Ваш відгук:</span><div class="feedback-value text-block">${plan.feedback || 'не залишено'}</div></div>
            <div class="feedback-inputs-grid">
                <div class="feedback-item"><span class="feedback-label">Складність:</span> <span class="feedback-value">${plan.difficulty || 'не вказано'}</span></div>
                <div class="feedback-item"><span class="feedback-label">Тривалість силової (хв):</span> <span class="feedback-value">${plan.training_duration || 'не вказано'}</span></div>
                <div class="feedback-item"><span class="feedback-label">Тривалість кардіо (хв):</span> <span class="feedback-value">${plan.cardio_duration || 'не вказано'}</span></div>
                <div class="feedback-item"><span class="feedback-label">Витрачено калорій:</span> <span class="feedback-value">${plan.calories_burned || 'не вказано'}</span></div>
            </div>
        </div>
    `;

  const interactiveFeedbackHTML = `
        <div class="feedback-inputs-grid">
            <div><label for="workout-feedback-duration">Тривалість силової (хв):</label><input type="number" id="workout-feedback-duration" min="0" step="1" value="${plan.training_duration || ''}"></div>
            <div><label for="workout-feedback-cardio">Тривалість кардіо (хв):</label><input type="number" id="workout-feedback-cardio" min="0" step="1" value="${plan.cardio_duration || ''}"></div>
            <div><label for="workout-feedback-calories">Витрачено калорій (приблизно):</label><input type="number" id="workout-feedback-calories" min="0" step="1" value="${plan.calories_burned || ''}"></div>
            <div><label for="workout-feedback-difficulty">Оцінка складності:</label><select id="workout-feedback-difficulty">
                <option value="">-- оберіть --</option>
                <option value="надто просто =(" ${plan.difficulty === 'надто просто =(' ? 'selected' : ''}>надто просто =(</option>
                <option value="легко." ${plan.difficulty === 'легко.' ? 'selected' : ''}>легко</option>
                <option value="середнє." ${plan.difficulty === 'середнє.' ? 'selected' : ''}>середнє</option>
                <option value="важко." ${plan.difficulty === 'важко.' ? 'selected' : ''}>важко</option>
                <option value="неможливо =)" ${plan.difficulty === 'неможливо =)' ? 'selected' : ''}>неможливо =)</option>
            </select></div>
        </div>
        <label for="workout-feedback">Ваші враження від тренування, складнощі, побажання:</label>
        <textarea id="workout-feedback" rows="4" placeholder="Наприклад: тренування пройшло чудово, але остання вправа була занадто важкою...">${plan.feedback || ''}</textarea>
    `;

  feedbackSectionContainer.innerHTML = `
        <div class="feedback-ai-analysis-container">
            <h4>${plan.ai_feedback_analysis ? 'Підсумок та аналіз тренування' : 'Фідбек та аналіз тренування'}</h4>
            ${plan.ai_feedback_analysis ? readonlyFeedbackHTML : interactiveFeedbackHTML}
            
            ${
              !plan.ai_feedback_analysis
                ? `
                <div class="feedback-action-container">
                    <button id="submit-feedback-and-analyze-btn" class="gemini-btn" data-plan-id="${plan.id}">Надіслати та отримати аналіз ✨</button>
                    <div id="feedback-status" class="status-message"></div>
                </div>`
                : ''
            }

            ${toggleHTML}

            <div id="ai-analysis-result-container">
                ${plan.ai_feedback_analysis ? `<h5>Аналіз тренування від Gemini</h5><div class="ai-analysis-text">${plan.ai_feedback_analysis}</div>` : ''}
            </div>
        </div>
    `;

  // Додаємо обробники подій до елементів, які ми щойно створили
  const analyzeBtn = document.getElementById('submit-feedback-and-analyze-btn');
  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', handleFeedbackAndAIAnalysis);
  }
  const toggleSwitch = document.getElementById('concise-analysis-toggle');
  if (toggleSwitch) {
    toggleSwitch.addEventListener('change', (event) => {
      updateConcisePreference(event.target.checked);
    });
  }
}

/**
 * Перевіряє на сервері, чи готовий результат аналізу, і оновлює інтерфейс.
 * @param {string} planId - ID тренування.
 * @returns {Promise<boolean>} - Повертає true, якщо результат готовий.
 */
async function checkForAnalysisResult(planId) {
  try {
    const { data: plan, response } = await fetchWithAuth(
      `${baseURL}/training_plans/${planId}`
    );

    // Якщо є готовий аналіз
    if (response.ok && plan && plan.ai_feedback_analysis) {
      //console.log(`Аналіз для плану ${planId} готовий! Оновлюємо інтерфейс.`);
      // Зупиняємо таймер, оскільки результат отримано
      if (aiAnalysisPollInterval) {
        clearInterval(aiAnalysisPollInterval);
        delete document.body.dataset.pollingPlanId; // Очищуємо ID
      }
      // Оновлюємо всю секцію фідбеку, показуючи готовий результат
      renderFeedbackSection(plan);
      return true; // Результат є
    }
  } catch (error) {
    console.error(
      `Помилка під час перевірки аналізу для плану ${planId}:`,
      error
    );
  }
  return false; // Результату ще немає
}

/**
 * Запускає періодичну перевірку готовності аналізу.
 * @param {number} planId - ID тренування.
 */
function startPollingForAIAnalysis(planId) {
  if (aiAnalysisPollInterval) clearInterval(aiAnalysisPollInterval);

  // Зберігаємо ID тренування, яке ми перевіряємо, щоб мати до нього доступ з інших функцій
  document.body.dataset.pollingPlanId = planId;

  let attempts = 0;
  const maxAttempts = 20; // Макс. кількість спроб (20 * 7 сек ≈ 2.5 хв)

  aiAnalysisPollInterval = setInterval(async () => {
    attempts++;
    const isDone = await checkForAnalysisResult(planId);

    // Зупиняємо, якщо результат отримано або перевищено ліміт спроб
    if (isDone || attempts >= maxAttempts) {
      clearInterval(aiAnalysisPollInterval);
      delete document.body.dataset.pollingPlanId; // Очищуємо ID
      if (!isDone) {
        displayStatus(
          'feedback-status',
          'Не вдалося автоматично завантажити аналіз. Оновіть сторінку.',
          true,
          10000
        );
      }
    }
  }, 7000); // Перевіряємо кожні 7 секунд
}

/**
 * Оновлює налаштування користувача щодо стислого аналізу на сервері.
 * @param {boolean} isConcise - Нове значення (true або false).
 */
async function updateConcisePreference(isConcise) {
  try {
    await fetchWithAuth(`${baseURL}/profile/preferences/concise-analysis`, {
      method: 'PUT',
      body: JSON.stringify({ prefers_concise_analysis: isConcise }),
    });
    // Оновлюємо локально збережені дані, щоб не перезавантажувати профіль
    if (currentUserProfileData) {
      currentUserProfileData.prefers_concise_analysis = isConcise;
    }
    const statusText = isConcise
      ? 'Наступний аналіз буде стислим.'
      : 'Наступний аналіз буде повним.';
    displayStatus('feedback-status', statusText, false, 3000);
  } catch (error) {
    console.error('Помилка оновлення налаштування стислого аналізу:', error);
    displayStatus('feedback-status', `Помилка: ${error.message}`, true, 5000);
  }
}
// --- Кінець блоку аналізу фідбеку від Gemini ---

// Функції кнопки виключення вправ
function initializeExcludeExerciseButtons(
  currentPlanId,
  currentUserExcludedNames
) {
  const excludeButtons = document.querySelectorAll(
    '#workout-details-exercises .exclude-exercise-btn'
  );
  excludeButtons.forEach((button) => {
    // Перевіряємо, чи обробник вже не додано (щоб уникнути дублювання)
    if (button.dataset.listenerAttached === 'true') return;
    button.dataset.listenerAttached = 'true';

    button.addEventListener('click', (event) => {
      const exerciseItemDiv = event.target.closest('.exercise-item');
      const gifName = exerciseItemDiv.dataset.gifName;

      if (!gifName) {
        alert('Неможливо виключити: назва вправи не визначена.');
        return;
      }

      const confirmationText = `Ви дійсно хочете виключити вправу "${gifName}"? Вона не буде пропонуватися у майбутніх планах і буде позначена у вашому профілі.`;

      showCustomConfirmationDialog(confirmationText, async () => {
        displayStatus(
          'workout-details-status',
          `Виключення вправи "${gifName}"...`,
          false
        );
        try {
          const { data: updatedExclusions, response } = await fetchWithAuth(
            `${baseURL}/profile/excluded-exercises`,
            {
              method: 'POST',
              body: JSON.stringify({ gif_name: gifName }),
            }
          );

          // Додаємо стандартну перевірку відповіді
          if (!response.ok) {
            // Використовуємо 'updatedExclusions', де буде об'єкт помилки
            throw new Error(
              updatedExclusions?.detail || `Помилка сервера: ${response.status}`
            );
          }

          displayStatus(
            'workout-details-status',
            `Вправа "${gifName}" додана до виключених.`,
            false,
            3000
          );
          exerciseItemDiv.classList.add('exercise-excluded-by-user'); // Підсвічуємо червоним
          event.target.remove(); // Видаляємо кнопку "хрестик"

          // Оновлюємо глобальний/локальний список виключених для негайного відображення
          if (!currentUserExcludedNames.includes(gifName)) {
            currentUserExcludedNames.push(gifName);
          }
          // Оновлюємо вигляд елемента у списку тренувань
          updateWorkoutListItemAppearance(currentPlanId, true); // true - бо ми щойно виключили
        } catch (error) {
          console.error(`Помилка виключення вправи "${gifName}":`, error);
          displayStatus(
            'workout-details-status',
            `Помилка виключення "${gifName}": ${error.message}`,
            true,
            5000
          );
        }
      });
    });
  });
} // --- кінець функції ShwoWorkoutDetails

function updateWorkoutListItemAppearance(planId, containsExcluded) {
  const workoutListItem = document.querySelector(
    `.workout-list-item[data-plan-id="${planId}"]`
  );
  if (workoutListItem) {
    if (containsExcluded) {
      workoutListItem.classList.add('contains-excluded-exercise'); // Клас для червоної лінії
    } else {
      // Якщо потрібно, можна прибрати клас, якщо всі виключені вправи були повернуті
      // workoutListItem.classList.remove('contains-excluded-exercise');
      // Але зазвичай, якщо вже є виключена, лінія залишається, поки користувач не прибере всі виключення з профілю
    }
  }
}

// --- Кінець модифікації showWorkoutDetails ---

// ========================================================================
// === ЛОГІКА СТВОРЕННЯ САМОСТІЙНОГО ТРЕНУВАННЯ (Фінал v9) ===
// ========================================================================

const FOLDER_TRANSLATIONS = {
  gym: 'Зал',
  home: 'Дім',
  street: 'Вулиця',
  trx: 'TRX',
  arms: 'Руки',
  abs: 'Прес',
  delts: 'Дельти',
  legs: 'Ноги',
  chest: 'Груди',
  back: 'Спина',
  functional: 'Функціонал',
  resistance_band: 'Гумові петлі',
  dumbbells: 'Гантелі',
  kettlebell: 'Гиря',
  body_weight: 'Вага тіла',
};

function translateFolderName(name) {
  const lowerCaseName = name ? name.toLowerCase() : '';
  return FOLDER_TRANSLATIONS[lowerCaseName] || name;
}

function showUserWorkoutForm() {
  showUserWorkoutView('form');
  currentEditingUserPlanId = null;
  loadAndApplyUserWorkoutDraft();
}

/**
 * Завантажує чернетку з localStorage.
 */
async function loadAndApplyUserWorkoutDraft() {
  const draftKey = getUserWorkoutDraftKey();
  const savedDraftJSON = localStorage.getItem(draftKey);
  if (savedDraftJSON) {
    try {
      const draftData = JSON.parse(savedDraftJSON);
      await setupUserWorkoutForm(draftData);
      displayStatus(
        'user-training-plan-message',
        'Знайдено та завантажено попередню чернетку.',
        false,
        3000
      );
    } catch (e) {
      console.error('Помилка парсингу чернетки:', e);
      await setupUserWorkoutForm(null);
    }
  } else {
    await setupUserWorkoutForm(null);
  }
}

/**
 * ФІНАЛЬНА ВЕРСІЯ 2.0: Налаштовує форму з динамічними заголовками та інтегрованим Gemini Helper.
 */
async function setupUserWorkoutForm(planData = null) {
  const formContainer = document.getElementById('workout-form-container-user');
  if (!formContainer) return;

  if (!currentUserProfileData) {
    currentUserProfileData = await fetchCurrentProfileDataOnce();
  }

  let formTitle = 'Самостійне тренування користувача';
  if (currentUserProfileData?.full_name) {
    formTitle += ` "${currentUserProfileData.full_name}"`;
  }
  let exercisesTitle = 'Вправи';
  if (currentUserProfileData) {
    let trainerName = null;
    const registrationType = currentUserProfileData.registration_type;

    if (currentUserProfileData.is_admin || currentUserProfileData.is_trainer) {
      // Сценарій 1: Користувач є адміном/тренером
      trainerName = currentUserProfileData.full_name;
    } else if (registrationType === 'by_trainer') {
      // Сценарій 2: Користувача зареєстрував тренер
      trainerName = currentUserProfileData.who_registered?.full_name;
    }

    if (trainerName) {
      exercisesTitle += ` тренера "${trainerName}"`;
    } else if (registrationType === 'self') {
      // Сценарій 3: Самостійна реєстрація
      const userGender = currentUserProfileData.gender;
      const preferredGender = currentUserProfileData.preferred_exercise_gender;
      let genderSetInfo = '';

      if (userGender === 'male' || preferredGender === 'male') {
        genderSetInfo = ' (чоловічий набір)';
      } else if (userGender === 'female' || preferredGender === 'female') {
        genderSetInfo = ' (жіночий набір)';
      }
      exercisesTitle += ` з бази LIMAX sport${genderSetInfo}`;
    }
  }

  currentEditingUserPlanId = planData?.id || null;

  // --- ПОЧАТОК ЗМІН: Додаємо HTML для Gemini Helper ---
  formContainer.innerHTML = `
        <form id="independent-workout-form">
            <button type="button" id="user-back-to-list-btn"> &lt; Назад до списку тренувань</button>
            <h3>${formTitle}</h3><hr>
            
            <div class="gemini-helper-container">
                <button type="button" id="user-toggle-gemini-helper-btn" class="gemini-btn">Допомога Gemini ✨</button>
                <div id="user-gemini-loader" class="gemini-spinner" style="display: none;"></div>
            </div>
            <div id="user-gemini-status" class="status-message"></div>
            <div id="user-gemini-input-section" style="display: none;">
                <label for="user-gemini-prompt-input">Увага! Генерація доступна 1 раз на 5 діб.</label>
                <label for="user-gemini-prompt-input">Опишіть, яке тренування ви хочете згенерувати:</label>
                <textarea id="user-gemini-prompt-input" class="auto-resize-textarea" placeholder="Наприклад: Важке тренування спини та біцепсу (в кінці в якості кардіо додамо декілька вправ на прес)"></textarea>
                <button type="button" id="user-generate-with-gemini-btn" class="main-action-button">Згенерувати</button>
            </div>
            <label for="user-training-title">Назва тренування:</label>
            <input type="text" id="user-training-title" name="training-title" required list="workout-names-list" placeholder="Оберіть або введіть свою назву">
            <datalist id="workout-names-list"><option value="Тренування ніг"></option><option value="Тренування спини"></option><option value="Тренування грудних м'язів"></option><option value="Тренування дельт"></option><option value="Тренування рук"></option><option value="Кругове тренування"></option><option value="Тренування фулбоді"></option><option value="Домашнє тренування"></option></datalist>
            <div class="form-row"><label for="user-training-date">Дата:</label><input type="date" id="user-training-date" name="training-date" required></div>
            <label for="user-training-description">Опис тренування (необов'язково):</label>
            <textarea id="user-training-description" name="training-description" class="auto-resize-textarea"></textarea>
            <hr><h3>${exercisesTitle}</h3>
            <div id="user-exercises-container"></div>
            <button type="button" id="user-add-exercise-btn" class="secondary-action-button">+ Додати вправу</button><hr>
            <div class="form-actions">
                <button type="submit" class="main-action-button">${currentEditingUserPlanId ? 'Оновити тренування' : 'Зберегти тренування'}</button>
                <button type="button" id="user-clear-workout-draft-btn" class="tertiary-action-button">Очистити форму</button>
            </div>
            <div id="user-training-plan-message" class="status-message"></div>
        </form>
    `;

  // --- ПОЧАТОК ЗМІН: Додаємо обробники подій для Gemini ---
  const toggleGeminiBtn = document.getElementById(
    'user-toggle-gemini-helper-btn'
  );
  const geminiInputSection = document.getElementById(
    'user-gemini-input-section'
  );
  const generateWithGeminiBtn = document.getElementById(
    'user-generate-with-gemini-btn'
  );

  if (toggleGeminiBtn && geminiInputSection) {
    toggleGeminiBtn.addEventListener('click', () => {
      const isVisible = geminiInputSection.style.display === 'block';
      geminiInputSection.style.display = isVisible ? 'none' : 'block';
    });
  }

  if (generateWithGeminiBtn) {
    generateWithGeminiBtn.addEventListener('click', handleUserGeminiGeneration);
  }
  // --- КІНЕЦЬ ЗМІН ---

  // Решта коду функції залишається без змін
  document
    .getElementById('user-add-exercise-btn')
    .addEventListener('click', handleUserAddExercise);
  document
    .getElementById('user-back-to-list-btn')
    .addEventListener('click', () => showUserWorkoutView('list'));
  document
    .getElementById('independent-workout-form')
    .addEventListener('submit', handleUserTrainingPlanSubmit);
  document
    .getElementById('user-clear-workout-draft-btn')
    .addEventListener('click', async () => {
      if (confirm('Очистити всю форму? Всі незбережені дані буде втрачено.')) {
        clearUserWorkoutDraft(true);
        await setupUserWorkoutForm(null);
        setTimeout(() => {
          const fc = document.getElementById('workout-form-container-user');
          if (fc) fc.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
      }
    });

  if (!userGifsCache['all']?.length) {
    displayStatus(
      'user-training-plan-message',
      'Завантаження ресурсів для вправ...'
    );
    userGifsCache['all'] = await loadGifsForUser();
    displayStatus('user-training-plan-message', '');
  }

  const form = document.getElementById('independent-workout-form');
  if (planData) {
    form.elements['training-title'].value = planData.title || '';
    form.elements['training-date'].value = planData.date
      ? new Date(planData.date).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];
    form.elements['training-description'].value = planData.description || '';
    if (planData.exercises?.length) {
      userExerciseCounter = 0;
      for (const exercise of planData.exercises.sort(
        (a, b) => a.order - b.order
      )) {
        const usePrefs = !planData.id;
        await addUserExerciseToFormWithData(exercise, usePrefs);
      }
    }
  } else {
    form.elements['training-date'].value = new Date()
      .toISOString()
      .split('T')[0];
    form.elements['training-description'].value =
      'Моє самостійне тренування. 💪';
    userExerciseCounter = 0;
  }

  autoResize(form.elements['training-description']);
  autoResize(form.elements['user-gemini-prompt-input']); // Також застосовуємо до поля Gemini
  attachUserDraftSaveListeners();
}

async function addUserExerciseToFormWithData(
  exerciseData,
  usePreferences = false
) {
  userExerciseCounter++;
  const exerciseFieldset = createExerciseFieldsetHTML(userExerciseCounter);
  document
    .getElementById('user-exercises-container')
    .appendChild(exerciseFieldset);
  exerciseFieldset.querySelector('.order-input').value =
    exerciseData.order || userExerciseCounter;
  const gifId = exerciseData.gif_id;
  if (gifId) {
    const gifData = (userGifsCache['all'] || []).find((g) => g.id == gifId);
    if (gifData) {
      await selectGifForUserExercise(
        exerciseFieldset,
        gifData,
        usePreferences,
        false
      );
    }
  }

  exerciseFieldset.querySelector('.superset-input').checked =
    exerciseData.superset || false;
  exerciseFieldset.querySelector('.emphasis-input').checked =
    exerciseData.emphasis || false;
  exerciseFieldset.querySelector('.total-weight-input').checked =
    exerciseData.total_weight || false;
  exerciseFieldset.querySelector('.total-reps-input').checked =
    exerciseData.total_reps || false;

  if (exerciseData.rest_time) {
    const totalSeconds = exerciseData.rest_time;
    exerciseFieldset.querySelector('.rest-time-minutes').value = Math.floor(
      totalSeconds / 60
    );
    exerciseFieldset.querySelector('.rest-time-seconds').value =
      totalSeconds % 60;
  }

  if (!usePreferences) {
    const setsInput = exerciseFieldset.querySelector('.sets-input');
    const setsTableContainer = exerciseFieldset.querySelector(
      '.sets-table-container'
    );
    const numSets = exerciseData.sets || 0;
    setsInput.value = numSets;
    generateUserEditableSetsTable(numSets, setsTableContainer);
    const repsSelects = setsTableContainer.querySelectorAll('.reps-select');
    const weightsSelects =
      setsTableContainer.querySelectorAll('.weight-select');
    const timeSelects = setsTableContainer.querySelectorAll('.time-select');
    for (let i = 0; i < numSets; i++) {
      if (repsSelects[i] && exerciseData.reps)
        repsSelects[i].value = exerciseData.reps[i] || '';
      if (weightsSelects[i] && exerciseData.weights)
        weightsSelects[i].value = exerciseData.weights[i] || '';
      if (timeSelects[i] && exerciseData.time)
        timeSelects[i].value = exerciseData.time[i] || '';
    }
  }

  // ▼▼▼ Ця функція більше не потрібна для опису, бо це не textarea ▼▼▼
  // autoResize(exerciseFieldset.querySelector('.description-input'));
}

/**
 * ЛОГІКА ДЛЯ "+ ДОДАТИ ВПРАВУ": Створює блок і показує браузер вгорі.
 */
async function handleUserAddExercise() {
  userExerciseCounter++;
  const exerciseFieldset = createExerciseFieldsetHTML(userExerciseCounter);
  document
    .getElementById('user-exercises-container')
    .appendChild(exerciseFieldset);

  // Ініціалізуємо браузер (якщо ще не було)
  await initializeGifBrowserForUser(exerciseFieldset, false); // false - означає "не переміщувати"

  exerciseFieldset.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * ЛОГІКА ДЛЯ "ЗМІНИТИ ВПРАВУ": Переміщує браузер під кнопку і показує його.
 */
async function handleChangeExercise(exerciseFieldset) {
  // Ініціалізуємо браузер (якщо ще не було) і кажемо йому переміститися
  await initializeGifBrowserForUser(exerciseFieldset, true); // true - означає "перемістити під кнопку"
}

/**
 * ФІНАЛЬНА ВЕРСІЯ: Правильна HTML-структура, де браузер і деталі є сусідами.
 */
function createExerciseFieldsetHTML(counter, exerciseId = null) {
  const exerciseFieldset = document.createElement('fieldset');
  exerciseFieldset.className = 'exercise exercise-item-in-form';

  exerciseFieldset.innerHTML = `
        <input type="hidden" class="order-input" value="${counter}">
        <input type="hidden" class="gif-id-input">
        <input type="hidden" class="exercise-id-input" value="${exerciseId || ''}">
        
        <div class="exercise-header-form">
            <h5 class="exercise-title-header"><span class="exercise-number">${counter}</span>. Вправа</h5>
        </div>

        <div class="gif-selector-container" style="display: none;">
            <div class="folder-selector"><div class="folder-buttons"></div></div>
            <div class="gif-grid"></div>
        </div>

        <div class="exercise-details-wrapper" style="display: none;">
            <h4 class="exercise-name-display"></h4>
            <div class="selected-gif-container">
                <img src="" class="form-gif-preview" alt="Прев'ю вправи" style="display: none;">
                <img src="" class="form-gif-final" alt="Анімація вправи" style="display: none;">
                <div class="form-gif-loader" style="display: none;"></div>
            </div>
            <button type="button" class="change-exercise-btn">Змінити вправу</button>
            <div class="technique-toggle"><span>Техніка виконання</span><span class="toggle-arrow">▼</span></div>
            <div class="technique-content"><div class="description-text"></div></div>
            <label>Кількість підходів:</label>
            <select class="sets-input" style="width: 100px; text-align: center;">
                ${Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}" ${i + 1 === 4 ? 'selected' : ''}>${i + 1}</option>`).join('')}
            </select>
            <div class="sets-table-container"></div>
            <div class="exercise-options">
                <label class="checkbox-label"><input type="checkbox" class="superset-input"> Суперсет</label>
                <label class="checkbox-label"><input type="checkbox" class="emphasis-input"> Акцент</label>
                <label class="checkbox-label"><input type="checkbox" class="total-weight-input" title="Загальна вага"> Заг. вага</label>
                <label class="checkbox-label"><input type="checkbox" class="total-reps-input" title="Загальна кількість"> Заг. к-ть</label>
            </div>
            <div class="rest-time-container">
                <label>Відпочинок:</label>
                <select class="rest-time-minutes"><option value="0">0</option>${Array.from({ length: 5 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select> <span>хв</span>
                <select class="rest-time-seconds"><option value="0">00</option><option value="10">10</option><option value="20">20</option><option value="30">30</option><option value="40">40</option><option value="50">50</option></select> <span>сек</span>
            </div>
        </div>
    `;

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-exercise-btn';
  deleteBtn.innerHTML = '❌';
  deleteBtn.className = 'delete-exercise-btn';
  deleteBtn.title = 'Видалити цю вправу';
  deleteBtn.onclick = () => {
    if (confirm('Видалити цю вправу?')) {
      exerciseFieldset.remove();
      document
        .querySelectorAll('#user-exercises-container .exercise-number')
        .forEach((span, idx) => {
          const currentExercise = span.closest('.exercise');
          if (currentExercise) {
            span.textContent = idx + 1;
            currentExercise.querySelector('.order-input').value = idx + 1;
          }
        });
      userExerciseCounter = document.getElementById('user-exercises-container')
        .children.length;
      saveUserWorkoutDraft();
    }
  };
  exerciseFieldset.appendChild(deleteBtn);

  // Ми будемо додавати слухачі динамічно в інших функціях
  return exerciseFieldset;
}

/**
 * ФІНАЛЬНА ВЕРСІЯ: "Розумно" оновлює таблицю підходів, зберігаючи введені дані.
 */
function generateUserEditableSetsTable(newSetsCount, container) {
  if (!container) return;

  let table = container.querySelector('table');

  // Якщо таблиці ще немає (наприклад, при першому додаванні вправи), створюємо її з нуля.
  if (!table) {
    container.innerHTML = ''; // Очищуємо на випадок, якщо там було щось інше
    if (!newSetsCount || newSetsCount <= 0) return;

    table = document.createElement('table');
    table.className = 'exercise-sets-table editable';
    table.innerHTML = `
            <thead><tr><th>Підхід</th><th>Повторення</th><th>Вага (кг)</th><th>Час (сек)</th></tr></thead>
            <tbody></tbody>
        `;
    container.appendChild(table);
  }

  const tbody = table.querySelector('tbody');
  const currentRowCount = tbody.children.length;

  // Маленька допоміжна функція для створення HTML-коду нового рядка
  const createRowHTML = (setNumber) => {
    return `
            <td>${setNumber}</td>
            <td><select name="reps[]" class="reps-select">${USER_REPS_OPTIONS}</select></td>
            <td><select name="weights[]" class="weight-select">${USER_WEIGHT_OPTIONS}</select></td>
            <td><select name="time[]" class="time-select">${USER_TIME_OPTIONS}</select></td>
        `;
  };

  // --- ОСНОВНА ЛОГІКА ---

  // Випадок 1: Кількість підходів ЗМЕНШИЛАСЬ
  if (newSetsCount < currentRowCount) {
    // Проходимо з кінця і видаляємо зайві рядки
    for (let i = currentRowCount - 1; i >= newSetsCount; i--) {
      tbody.children[i].remove();
    }
  }
  // Випадок 2: Кількість підходів ЗБІЛЬШИЛАСЬ
  else if (newSetsCount > currentRowCount) {
    // Проходимо від поточної кількості до нової і додаємо нові рядки
    for (let i = currentRowCount + 1; i <= newSetsCount; i++) {
      const tr = document.createElement('tr');
      tr.innerHTML = createRowHTML(i);
      tbody.appendChild(tr);
    }
  }
  // Якщо newSetsCount === currentRowCount, нічого не робимо, всі дані на місці.
}

/**
 * Ініціалізує браузер GIF, опціонально переміщуючи його під кнопку "Змінити".
 */
async function initializeGifBrowserForUser(exerciseFieldset, shouldMove) {
  const selectorContainer = exerciseFieldset.querySelector(
    '.gif-selector-container'
  );
  if (!selectorContainer) return;

  // Якщо нам потрібно перемістити браузер (для кнопки "Змінити вправу")
  if (shouldMove) {
    const changeBtn = exerciseFieldset.querySelector('.change-exercise-btn');
    // Метод insertAdjacentElement('afterend', ...) вставляє елемент одразу після кнопки
    changeBtn.insertAdjacentElement('afterend', selectorContainer);
  }

  selectorContainer.style.display = 'block';

  if (selectorContainer.dataset.initialized === 'true') return;

  // ... (решта коду цієї функції залишається без змін: завантаження GIF, getContentsForPath, renderBrowser, і т.д.) ...
  const gifGrid = exerciseFieldset.querySelector('.gif-grid');
  const folderSelector = exerciseFieldset.querySelector('.folder-selector');
  const directoryContainer = folderSelector.querySelector('.folder-buttons');

  gifGrid.innerHTML = '<p>Завантаження вправ...</p>';
  if (!userGifsCache['all']?.length) {
    userGifsCache['all'] = await loadGifsForUser();
  }
  const gifsForBrowser = userGifsCache['all'] || [];

  if (gifsForBrowser.length === 0) {
    gifGrid.innerHTML = '<p>Доступні вправи відсутні.</p>';
    return;
  }

  const getContentsForPath = (allGifs, pathArray) => {
    const subdirectories = new Set();
    const files = [];
    const pathDepth = pathArray.length;
    if (!allGifs) return { subdirectories: [], files: [] };
    allGifs.forEach((gif) => {
      const gifParts = gif.filename.split('/').slice(1);
      if (gifParts.length <= pathDepth) return;
      let prefixMatches = true;
      for (let i = 0; i < pathDepth; i++) {
        if (gifParts[i] !== pathArray[i]) {
          prefixMatches = false;
          break;
        }
      }
      if (!prefixMatches) return;
      const partsAfterPrefix = gifParts.length - pathDepth;
      if (partsAfterPrefix > 1) {
        subdirectories.add(gifParts[pathDepth]);
      } else if (partsAfterPrefix === 1) {
        files.push(gif);
      }
    });
    return { subdirectories: Array.from(subdirectories).sort(), files };
  };

  let currentPath = [];
  const renderBrowser = (pathArray) => {
    directoryContainer.innerHTML = '';
    gifGrid.innerHTML = '';
    let rootTitle = 'Всі вправи';
    if (currentUserProfileData) {
      let trainerName = null;
      if (
        currentUserProfileData.is_admin ||
        currentUserProfileData.is_trainer
      ) {
        trainerName = currentUserProfileData.full_name;
      } else if (
        currentUserProfileData.registration_type === 'by_trainer' &&
        currentUserProfileData.who_registered?.full_name
      ) {
        trainerName = currentUserProfileData.who_registered.full_name;
      }
      if (trainerName) {
        rootTitle = `Вправи тренера "${trainerName}"`;
      }
    }

    const displayPath = [
      '📁 ' + rootTitle,
      ...pathArray.map((p) => translateFolderName(p)),
    ].join(' / ');
    directoryContainer.innerHTML = `<h5 class="level-title">${displayPath}</h5>`;
    const content = getContentsForPath(gifsForBrowser, pathArray);
    if (pathArray.length > 0) {
      const backButton = document.createElement('button');
      backButton.className = 'back-btn';
      backButton.textContent = '⬅️ Назад';
      directoryContainer.appendChild(backButton);
    }
    content.subdirectories.forEach((dir) => {
      const button = document.createElement('button');
      button.className = 'directory-btn';
      button.dataset.dir = dir;
      button.textContent = translateFolderName(dir);
      directoryContainer.appendChild(button);
    });
    if (content.files.length > 0) {
      displayGifsForUser(content.files, exerciseFieldset);
      gifGrid.style.display = 'grid';
    } else {
      gifGrid.style.display = 'none';
    }
  };

  folderSelector.addEventListener('click', (e) => {
    if (e.target.matches('.directory-btn')) {
      currentPath.push(e.target.dataset.dir);
      renderBrowser(currentPath);
    } else if (e.target.matches('.back-btn')) {
      currentPath.pop();
      renderBrowser(currentPath);
    }
  });

  renderBrowser(currentPath);
  selectorContainer.dataset.initialized = 'true';
}

/**
 * ФІНАЛЬНА ВЕРСІЯ 3.0: Дозволяє другий клік не чекаючи завантаження GIF.
 */
function displayGifsForUser(gifs, exerciseFieldset) {
  const gifGrid = exerciseFieldset.querySelector('.gif-grid');
  if (!gifGrid) return;

  gifGrid.innerHTML = '';
  if (!gifs || gifs.length === 0) {
    gifGrid.innerHTML = '<p>GIF не знайдено для цього розділу.</p>';
    gifGrid.style.display = 'block';
    return;
  }

  gifs.forEach((gif) => {
    const gridCell = document.createElement('div');
    gridCell.className = 'grid-cell';

    const gifItem = document.createElement('div');
    gifItem.className = 'gif-item';
    gifItem.title =
      'Натисніть для перегляду анімації, натисніть ще раз для вибору';

    const previewImg = document.createElement('img');
    previewImg.className = 'gif-preview';
    const pngFilename =
      (gif.filename.substring(0, gif.filename.lastIndexOf('.')) ||
        gif.filename) + '.png';
    previewImg.src = `https://limaxsport.top/static/gifs/${pngFilename}`;
    previewImg.alt = gif.name || "Прев'ю";
    previewImg.loading = 'lazy';

    const fullGifImg = document.createElement('img');
    fullGifImg.className = 'gif-full';
    fullGifImg.alt = gif.name || 'Анімація вправи';

    const loader = document.createElement('div');
    loader.className = 'loader';

    const nameLabel = document.createElement('span');
    nameLabel.textContent = gif.name || '(без назви)';
    nameLabel.className = 'gif-name-label';

    // --- ОНОВЛЕНА ЛОГІКА ДВОХ КЛІКІВ ---
    gifItem.addEventListener('click', () => {
      // ПЕРЕВІРКА: Це другий клік? (тобто, завантаження вже почалося або завершилося)
      if (
        gifItem.classList.contains('is-loading') ||
        gifItem.classList.contains('is-loaded')
      ) {
        // Так, це другий клік. Негайно обираємо вправу.
        selectGifForUserExercise(exerciseFieldset, gif, true, true);
        const selectorContainer = exerciseFieldset.querySelector(
          '.gif-selector-container'
        );
        if (selectorContainer) {
          selectorContainer.style.display = 'none';
        }
        return; // Завершуємо дію
      }

      // Якщо ми тут, це точно ПЕРШИЙ клік.
      // Запускаємо процес завантаження.
      gifItem.classList.add('is-loading');
      fullGifImg.src = `https://limaxsport.top/static/gifs/${gif.filename}`;

      fullGifImg.onload = () => {
        gifItem.classList.remove('is-loading');
        gifItem.classList.add('is-loaded');
      };

      fullGifImg.onerror = () => {
        gifItem.classList.remove('is-loading');
        console.error('Не вдалося завантажити GIF:', fullGifImg.src);
      };
    });

    gifItem.appendChild(previewImg);
    gifItem.appendChild(fullGifImg);
    gifItem.appendChild(loader);

    gridCell.appendChild(gifItem);
    gridCell.appendChild(nameLabel);
    gifGrid.appendChild(gridCell);
  });

  gifGrid.style.display = 'grid';
}

async function loadGifsForUser() {
  const cacheKey = `user_available_gifs`;
  if (userGifsCache[cacheKey]) {
    return userGifsCache[cacheKey];
  }
  const { data } = await fetchWithAuth(`${baseURL}/gifs`);
  userGifsCache[cacheKey] = data || [];
  return userGifsCache[cacheKey];
}

/**
 * ФІНАЛЬНА ВЕРСІЯ: Правильно налаштовує кнопку "Змінити вправу".
 */
async function selectGifForUserExercise(
  fieldset,
  gif,
  loadPreferences = true,
  shouldScroll = false
) {
  const detailsWrapper = fieldset.querySelector('.exercise-details-wrapper');
  const selectorContainer = fieldset.querySelector('.gif-selector-container');
  selectorContainer.style.display = 'none';
  detailsWrapper.style.display = 'block';

  // ... (весь код заповнення даних, завантаження анімації та переваг залишається тут) ...
  const nameDisplay = fieldset.querySelector('.exercise-name-display');
  const descriptionText = fieldset.querySelector('.description-text');
  fieldset.querySelector('.gif-id-input').value = gif.id;
  nameDisplay.textContent = gif.name || '';
  descriptionText.textContent = gif.description || '';
  const finalGifImg = fieldset.querySelector('.form-gif-final');
  const loader = fieldset.querySelector('.form-gif-loader');
  const previewImg = fieldset.querySelector('.form-gif-preview');
  const pngUrl = `https://limaxsport.top/static/gifs/${gif.filename.substring(0, gif.filename.lastIndexOf('.')) || gif.filename}.png`;
  previewImg.src = pngUrl;
  previewImg.style.display = 'block';
  finalGifImg.style.display = 'none';
  loader.style.display = 'block';
  finalGifImg.src = `https://limaxsport.top/static/gifs/${gif.filename}`;
  finalGifImg.onload = () => {
    loader.style.display = 'none';
    previewImg.style.display = 'none';
    finalGifImg.style.display = 'block';
  };
  finalGifImg.onerror = () => {
    console.error(`Не вдалося завантажити GIF: ${finalGifImg.src}`);
    loader.style.display = 'none';
  };
  if (loadPreferences && currentUserProfileData?.exercise_preferences_summary) {
    const preferences =
      currentUserProfileData.exercise_preferences_summary.find(
        (p) => p.gif_name === gif.name
      );
    const setsInput = fieldset.querySelector('.sets-input');
    const setsTableContainer = fieldset.querySelector('.sets-table-container');
    if (preferences?.reps?.length > 0) {
      const numSets = preferences.reps.length;
      setsInput.value = numSets;
      generateUserEditableSetsTable(numSets, setsTableContainer);
      const repsSelects = setsTableContainer.querySelectorAll('.reps-select');
      const weightsSelects =
        setsTableContainer.querySelectorAll('.weight-select');
      const timeSelects = setsTableContainer.querySelectorAll('.time-select');
      for (let i = 0; i < numSets; i++) {
        if (repsSelects[i] && preferences.reps)
          repsSelects[i].value = preferences.reps[i] ?? '';
        if (weightsSelects[i] && preferences.weights)
          weightsSelects[i].value = preferences.weights[i] ?? '';
        if (timeSelects[i] && preferences.time)
          timeSelects[i].value = preferences.time[i] ?? '';
      }
    } else {
      const defaultSets = 4;
      setsInput.value = defaultSets;
      setsTableContainer.innerHTML = '';
      generateUserEditableSetsTable(defaultSets, setsTableContainer);
    }
  } else {
    const setsInput = fieldset.querySelector('.sets-input');
    const setsTableContainer = fieldset.querySelector('.sets-table-container');
    generateUserEditableSetsTable(
      parseInt(setsInput.value) || 4,
      setsTableContainer
    );
  }

  // Налаштовуємо обробники подій для блоку, що став видимим
  const changeBtn = fieldset.querySelector('.change-exercise-btn');
  if (changeBtn && !changeBtn.dataset.listenerAttached) {
    // Тепер ця кнопка викликає свою власну, правильну функцію
    changeBtn.addEventListener('click', () => handleChangeExercise(fieldset));
    changeBtn.dataset.listenerAttached = 'true';
  }
  const setsDropdown = fieldset.querySelector('.sets-input');
  if (setsDropdown && !setsDropdown.dataset.listenerAttached) {
    setsDropdown.addEventListener('change', (e) => {
      generateUserEditableSetsTable(
        parseInt(e.target.value) || 0,
        fieldset.querySelector('.sets-table-container')
      );
      saveUserWorkoutDraft();
    });
    setsDropdown.dataset.listenerAttached = 'true';
  }
  const techniqueToggle = fieldset.querySelector('.technique-toggle');
  if (techniqueToggle && !techniqueToggle.dataset.listenerAttached) {
    techniqueToggle.addEventListener('click', () => {
      techniqueToggle.classList.toggle('active');
      const content = fieldset.querySelector('.technique-content');
      content.classList.toggle('expanded');
    });
    techniqueToggle.dataset.listenerAttached = 'true';
  }

  if (shouldScroll) {
    setTimeout(
      () => fieldset.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      100
    );
  }
  saveUserWorkoutDraft();
}

function getUserWorkoutDraftKey() {
  return 'user_workout_draft_new';
}

function saveUserWorkoutDraft() {
  clearTimeout(userWorkoutDraftTimeout);
  userWorkoutDraftTimeout = setTimeout(() => {
    const draftKey = getUserWorkoutDraftKey();
    const form = document.getElementById('independent-workout-form');
    if (!form) return;
    const draftData = {
      title: form.elements['training-title'].value,
      date: form.elements['training-date'].value,
      description: form.elements['training-description'].value,
      exercises: Array.from(
        form.querySelectorAll('#user-exercises-container .exercise')
      ).map((fs) => {
        const restMinutes = parseInt(
          fs.querySelector('.rest-time-minutes')?.value || '0'
        );
        const restSeconds = parseInt(
          fs.querySelector('.rest-time-seconds')?.value || '0'
        );
        return {
          gif_id: fs.querySelector('.gif-id-input')?.value || null,
          name: fs.querySelector('.exercise-name-display')?.textContent.trim(),
          description: fs.querySelector('.description-input')?.value,
          order: fs.querySelector('.order-input')?.value,
          superset: fs.querySelector('.superset-input')?.checked ?? false,
          emphasis: fs.querySelector('.emphasis-input')?.checked ?? false,
          total_weight:
            fs.querySelector('.total-weight-input')?.checked ?? false,
          total_reps: fs.querySelector('.total-reps-input')?.checked ?? false,
          rest_time: restMinutes * 60 + restSeconds || null,
          sets: parseInt(fs.querySelector('.sets-input')?.value || '0'),
          reps: Array.from(fs.querySelectorAll('.reps-select')).map((s) =>
            s.value ? parseInt(s.value) : null
          ),
          weights: Array.from(fs.querySelectorAll('.weight-select')).map((s) =>
            s.value ? parseInt(s.value) : null
          ),
          time: Array.from(fs.querySelectorAll('.time-select')).map((s) =>
            s.value ? parseInt(s.value) : null
          ),
        };
      }),
    };
    localStorage.setItem(draftKey, JSON.stringify(draftData));
    displayStatus(
      'user-training-plan-message',
      'Чернетку збережено.',
      false,
      2000
    );
  }, 1500);
}

function clearUserWorkoutDraft(showMessage = false) {
  localStorage.removeItem(getUserWorkoutDraftKey());
  if (showMessage) {
    displayStatus(
      'user-training-plan-message',
      'Чернетку видалено.',
      false,
      2000
    );
  }
}

function attachUserDraftSaveListeners() {
  const form = document.getElementById('independent-workout-form');
  if (form) {
    form.addEventListener('input', saveUserWorkoutDraft);
    form.addEventListener('change', saveUserWorkoutDraft);
  }
}

/**
 * ФІНАЛЬНА ВЕРСІЯ: Коректно збирає дані з нової структури форми.
 */
async function handleUserTrainingPlanSubmit(event) {
  event.preventDefault();
  const form = document.getElementById('independent-workout-form');
  if (!form) return;
  const messageDivId = 'user-training-plan-message';
  displayStatus(messageDivId, 'Збереження тренування...');
  let validationErrors = [];
  const trainingPlanData = {
    title: form.elements['training-title'].value.trim(),
    date: form.elements['training-date'].value,
    description: form.elements['training-description'].value.trim() || null,
    exercises: [],
  };
  if (!trainingPlanData.title)
    validationErrors.push('Вкажіть назву тренування.');
  if (!trainingPlanData.date) validationErrors.push('Вкажіть дату тренування.');
  const exerciseFieldsets = document.querySelectorAll(
    '#user-exercises-container .exercise'
  );
  if (exerciseFieldsets.length === 0) {
    validationErrors.push('Додайте хоча б одну вправу.');
  }
  exerciseFieldsets.forEach((fs, index) => {
    const exerciseNumber = index + 1;
    const gifId = fs.querySelector('.gif-id-input').value;
    const name = fs.querySelector('.exercise-name-display').textContent.trim();
    const sets = parseInt(fs.querySelector('.sets-input').value) || 0;
    if (!gifId)
      validationErrors.push(`Вправа №${exerciseNumber}: не обрано GIF.`);
    if (!name)
      validationErrors.push(`Вправа №${exerciseNumber}: не вказано назву.`);
    if (sets <= 0)
      validationErrors.push(
        `Вправа №${exerciseNumber}: кількість підходів має бути більше 0.`
      );
    const restMinutes = parseInt(
      fs.querySelector('.rest-time-minutes')?.value || '0'
    );
    const restSeconds = parseInt(
      fs.querySelector('.rest-time-seconds')?.value || '0'
    );
    trainingPlanData.exercises.push({
      id: fs.querySelector('.exercise-id-input')?.value || null,
      gif_id: parseInt(gifId),
      order: parseInt(fs.querySelector('.order-input').value),
      superset: fs.querySelector('.superset-input').checked,
      emphasis: fs.querySelector('.emphasis-input').checked,
      total_weight: fs.querySelector('.total-weight-input').checked,
      total_reps: fs.querySelector('.total-reps-input').checked,
      rest_time: restMinutes * 60 + restSeconds || null,
      sets: sets,
      reps: Array.from(fs.querySelectorAll('.reps-select')).map((s) =>
        s.value ? parseInt(s.value) : null
      ),
      weights: Array.from(fs.querySelectorAll('.weight-select')).map((s) =>
        s.value ? parseInt(s.value) : null
      ),
      time: Array.from(fs.querySelectorAll('.time-select')).map((s) =>
        s.value ? parseInt(s.value) : null
      ),
    });
  });
  if (validationErrors.length > 0) {
    displayStatus(
      messageDivId,
      'Будь ласка, виправте помилки:\n' + validationErrors.join('\n'),
      true
    );
    return;
  }
  try {
    let responseData, response;
    if (currentEditingUserPlanId) {
      const result = await fetchWithAuth(
        `${baseURL}/training_plans/${currentEditingUserPlanId}`,
        { method: 'PUT', body: JSON.stringify(trainingPlanData) }
      );
      responseData = result.data;
      response = result.response;
    } else {
      const result = await fetchWithAuth(`${baseURL}/training_plans`, {
        method: 'POST',
        body: JSON.stringify(trainingPlanData),
      });
      responseData = result.data;
      response = result.response;
    }
    if (!response.ok) {
      throw new Error(
        responseData.detail || `Помилка сервера: ${response.status}`
      );
    }
    const successMessage = currentEditingUserPlanId
      ? 'Тренування успішно оновлено!'
      : 'Якісного тренування, друже!';
    displayStatus(messageDivId, successMessage, false);
    clearUserWorkoutDraft(false);
    currentEditingUserPlanId = null;
    setTimeout(() => {
      showUserWorkoutView('list');
      loadWorkoutList().then(() => {
        const listContainer = document.getElementById('workout-list-container');
        if (listContainer)
          listContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }, 1500);
  } catch (error) {
    displayStatus(messageDivId, `Помилка: ${error.message}`, true);
  }
}

/**
 * Обробляє редагування тренування.
 * @param {number} planId - ID тренування, яке потрібно редагувати.
 */
async function handleEditWorkout(planId) {
  displayStatus(
    'workout-list-status',
    'Завантаження тренування для редагування...',
    false
  );
  try {
    const { data: planToEdit, response } = await fetchWithAuth(
      `${baseURL}/training_plans/${planId}`
    );
    if (!response.ok) {
      throw new Error(
        planToEdit.detail ||
          `Помилка завантаження тренування: ${response.status}`
      );
    }

    // Додаємо перевірку на факт виконання вправ у цьому тренуванні
    const completedExercisesMap = JSON.parse(
      localStorage.getItem(`completedPlan_${planId}`) || '{}'
    );

    const preparedData = {
      id: planToEdit.id,
      title: planToEdit.title,
      description: planToEdit.description,
      date: planToEdit.date,
      exercises: planToEdit.exercises.map((ex) => {
        // Якщо є факт виконання — додаємо його до даних вправи
        const completed = completedExercisesMap[ex.id];
        return {
          gif_id: ex.gif.id,
          name: ex.gif.name,
          description: ex.gif.description,
          order: ex.order,
          superset: ex.superset,
          emphasis: ex.emphasis,
          total_weight: ex.total_weight,
          total_reps: ex.total_reps,
          rest_time: ex.rest_time,
          sets: ex.sets,
          reps: ex.reps,
          weights: ex.weights,
          time: ex.time,
          // Додаємо факт виконання, якщо він є
          completedReps: completed?.completedReps || null,
          completedWeights: completed?.completedWeights || null,
          completedTime: completed?.completedTime || null,
        };
      }),
    };

    showUserWorkoutView('form');
    await setupUserWorkoutForm(preparedData);
    displayStatus(
      'user-training-plan-message',
      'Тренування завантажено. Внесіть зміни та збережіть.',
      false,
      4000
    );
    const formContainer = document.getElementById(
      'workout-form-container-user'
    );
    if (formContainer) {
      formContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (error) {
    alert(`Не вдалося завантажити для редагування: ${error.message}`);
  } finally {
    displayStatus('workout-list-status', '', false);
  }
}

/**
 * ФІНАЛЬНА ВЕРСІЯ: Обробляє дублювання, пріоритезуючи кількість підходів зі збережених переваг користувача.
 * @param {number} planId - ID тренування, яке потрібно дублювати.
 */
async function handleDuplicateWorkout(planId) {
  if (!confirm('Створити копію цього тренування?')) {
    return;
  }
  displayStatus('workout-list-status', 'Створення дублікату...', false);
  try {
    const { data: planToDuplicate, response } = await fetchWithAuth(
      `${baseURL}/training_plans/${planId}`
    );
    if (!response.ok) {
      throw new Error(
        planToDuplicate.detail ||
          `Помилка завантаження тренування: ${response.status}`
      );
    }
    if (!currentUserProfileData) {
      currentUserProfileData = await fetchCurrentProfileDataOnce();
    }
    const preparedData = {
      title: planToDuplicate.title,
      description: planToDuplicate.description,
      date: new Date().toISOString().split('T')[0],
      exercises: planToDuplicate.exercises.map((ex) => {
        const userPrefs =
          currentUserProfileData?.exercise_preferences_summary?.find(
            (p) => p.gif_name === ex.gif.name
          );
        const hasValidPrefs =
          userPrefs &&
          Array.isArray(userPrefs.reps) &&
          userPrefs.reps.length > 0;
        return {
          gif_id: ex.gif.id,
          name: ex.gif.name,
          description: ex.gif.description,
          order: ex.order,
          superset: ex.superset,
          emphasis: ex.emphasis,
          total_weight: ex.total_weight,
          total_reps: ex.total_reps,
          rest_time: ex.rest_time,
          sets: hasValidPrefs ? userPrefs.reps.length : ex.sets,
          reps: hasValidPrefs ? userPrefs.reps : Array(ex.sets).fill(null),
          weights: hasValidPrefs
            ? userPrefs.weights
            : Array(ex.sets).fill(null),
          time: hasValidPrefs ? userPrefs.time : Array(ex.sets).fill(null),
        };
      }),
    };
    showUserWorkoutView('form');
    await setupUserWorkoutForm(preparedData);
    displayStatus(
      'user-training-plan-message',
      'Дублікат тренування створено. Перевірте та збережіть.',
      false,
      4000
    );
    const formContainer = document.getElementById(
      'workout-form-container-user'
    );
    if (formContainer) {
      formContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (error) {
    alert(`Не вдалося створити дублікат: ${error.message}`);
  } finally {
    displayStatus('workout-list-status', '', false);
  }
}

// --- Кінець блоку створення самостійного тренування --- //

// ========================================================================
// === ЛОГІКА GEMINI ДЛЯ КОРИСТУВАЧА ===
// ========================================================================

/**
 * Керує відображенням спіннера завантаження для форми користувача.
 * @param {boolean} show - true, щоб показати, false - щоб сховати.
 */
function toggleUserGeminiLoader(show) {
  const loader = document.getElementById('user-gemini-loader');
  if (loader) {
    loader.style.display = show ? 'block' : 'none';
  }
}

/**
 * Заповнює форму самостійного тренування даними, отриманими від Gemini.
 * @param {object} aiData - Об'єкт тренування, що відповідає моделі AIGeneratedWorkout.
 */
async function populateUserFormWithAIData(aiData) {
  //console.log("[AI User] Заповнення форми даними від Gemini:", aiData);
  const form = document.getElementById('independent-workout-form');
  const exercisesContainer = document.getElementById(
    'user-exercises-container'
  );
  if (!form || !exercisesContainer) {
    console.error(
      '[AI User] Не знайдено форму або контейнер вправ для заповнення.'
    );
    return;
  }

  // Очищуємо поточні вправи з форми
  exercisesContainer.innerHTML = '';
  userExerciseCounter = 0; // Скидаємо лічильник

  // Заповнюємо загальні поля форми
  form.elements['training-title'].value = aiData.title || '';
  form.elements['training-description'].value = aiData.description || '';
  autoResize(form.elements['training-description']);
  form.elements['training-date'].value = ''; // Очищуємо дату, щоб користувач встановив її сам

  // Додаємо вправи в циклі
  if (aiData.exercises && aiData.exercises.length > 0) {
    // Сортуємо вправи за полем 'order' від ШІ
    const sortedExercises = aiData.exercises.sort(
      (a, b) => (a.order || 0) - (b.order || 0)
    );

    for (const exercise of sortedExercises) {
      // addUserExerciseToFormWithData - це правильна функція для цієї форми
      // Вона використовує userGifsCache, який вже завантажений для цього контексту
      await addUserExerciseToFormWithData(
        { gif_id: exercise.gif_id, ...exercise },
        false
      );

      // Підсвічуємо таблицю, якщо вона заснована на перевагах
      if (exercise.based_on_preference === true) {
        const lastExerciseBlock = exercisesContainer.lastElementChild;
        if (lastExerciseBlock) {
          const tableContainer = lastExerciseBlock.querySelector(
            '.sets-table-container'
          );
          if (tableContainer) {
            tableContainer.classList.add('preference-based-table');
          }
        }
      }
    }
  }

  // Зберігаємо чернетку після заповнення
  saveUserWorkoutDraft();
  alert(
    'Тренування від Gemini успішно згенеровано! Перевірте дані, встановіть бажану дату та збережіть тренування.'
  );
}

/**
 * Обробляє запит на генерацію тренування через Gemini для поточного користувача.
 * ФІНАЛЬНА ВЕРСІЯ з розумним індикатором статусу.
 */
async function handleUserGeminiGeneration() {
  const promptInput = document.getElementById('user-gemini-prompt-input');
  const statusDiv = document.getElementById('user-gemini-status');
  const inputSection = document.getElementById('user-gemini-input-section');
  const generateBtn = document.getElementById('user-generate-with-gemini-btn');
  const toggleBtn = document.getElementById('user-toggle-gemini-helper-btn');
  const loader = document.getElementById('user-gemini-loader');

  const promptText = promptInput.value.trim();

  if (!promptText) {
    displayStatus(
      statusDiv.id,
      'Будь ласка, введіть опис тренування.',
      true,
      3000
    );
    return;
  }

  // Блокуємо UI
  if (generateBtn) generateBtn.disabled = true;
  if (toggleBtn) toggleBtn.disabled = true;
  if (loader) loader.style.display = 'block';

  // --- НОВА ЛОГІКА СТАТУСІВ ---
  // Початкове повідомлення
  displayStatus(
    statusDiv.id,
    'Звертаємось до Gemini ✨. Генерація тренування...',
    false
  );

  // Таймер, який покаже додаткове повідомлення, якщо процес затягнеться
  const longProcessTimer = setTimeout(() => {
    displayStatus(
      statusDiv.id,
      'Процес триває... Gemini аналізує ваш запит та підбирає найкращі вправи. Це може зайняти до хвилини.',
      false
    );
  }, 10000); // Показуємо через 10 секунд
  // --- КІНЕЦЬ НОВОЇ ЛОГІКИ ---

  const requestBody = {
    muscle_group: promptText,
  };

  try {
    const { data: generatedWorkout, response } = await fetchWithAuth(
      `${baseURL}/ai/generate-workout`,
      {
        method: 'POST',
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const error = new Error(
        generatedWorkout.detail || `Помилка сервера: ${response.status}`
      );
      error.status = response.status;
      throw error;
    }

    await populateUserFormWithAIData(generatedWorkout);

    displayStatus(
      statusDiv.id,
      'Тренування успішно згенеровано! Перевірте та збережіть.',
      false,
      5000
    );
    if (inputSection) inputSection.style.display = 'none';
  } catch (error) {
    console.error(
      'Помилка генерації тренування через Gemini для користувача:',
      error
    );
    displayStatus(statusDiv.id, `Помилка: ${error.message}`, true, 10000);

    if (error.status === 429) {
      // Показуємо користувачу повідомлення про ліміт
      displayStatus(
        statusDiv.id,
        'Ви вже використали свою спробу генерації. Наступна буде доступна через 5 днів.',
        true, // Показуємо як помилку
        10000 // Повідомлення зникне через 10 секунд
      );
      // Ховаємо секцію вводу, оскільки вона більше не потрібна
      if (inputSection) inputSection.style.display = 'none';
    } else {
      // Для всіх інших помилок показуємо стандартне повідомлення
      displayStatus(statusDiv.id, `Помилка: ${error.message}`, true, 10000);
      // І залишаємо секцію вводу видимою, щоб користувач міг спробувати ще раз
      if (inputSection) inputSection.style.display = 'block';
    }
  } finally {
    // Завжди очищуємо таймер, незалежно від результату
    clearTimeout(longProcessTimer);

    // Розблоковуємо UI
    if (loader) loader.style.display = 'none';
    if (generateBtn) generateBtn.disabled = false;
    if (toggleBtn) toggleBtn.disabled = false;
  }
}

/**
 * Генерує HTML для РЕДАГОВАНОЇ таблиці підходів.
 * Відображає стовпці для Повторень, Ваги, Часу тільки якщо для них були дані в плані.
 * У кожному такому стовпці відображається планове значення, яке можна редагувати.
 * @param {object} exercise - Об'єкт вправи з даними плану (exercise.sets, .reps, .weights, .time).
 * @returns {string} HTML рядок таблиці.
 */
function generateEditableSetsTableHTML(
  exercise,
  planId,
  originalSetCount,
  isCompleted
) {
  const numSets = exercise.sets;
  if (!numSets || numSets <= 0) {
    return '<p style="font-style: italic; color: #aaa;">Кількість підходів не вказана тренером.</p>';
  }

  const plannedReps = exercise.reps || [];
  const plannedWeights = exercise.weights || [];
  const plannedTime = exercise.time || [];

  const hasActualDataInPlan = (arr) =>
    Array.isArray(arr) && arr.some((val) => val !== null && val !== undefined);

  // Визначаємо, які типи показників (метрики) релевантні для цієї вправи на основі плану тренера
  const showRepsMetric = hasActualDataInPlan(plannedReps);
  const showWeightsMetric = hasActualDataInPlan(plannedWeights);
  const showTimeMetric = hasActualDataInPlan(plannedTime);

  // +++ ДОДАЙТЕ ЦЕЙ БЛОК: Розраховуємо, скільки колонок буде в таблиці +++
  let colspanValue = 1; // Починаємо з 1 (колонка "Підхід")
  if (showRepsMetric) colspanValue++;
  if (showWeightsMetric) colspanValue++;
  if (showTimeMetric) colspanValue++;
  // +++ КІНЕЦЬ НОВОГО БЛОКУ +++

  // Якщо тренер не запланував жодних деталей (тільки кількість підходів),
  // а користувач все одно має якось позначити виконання.
  if (!showRepsMetric && !showWeightsMetric && !showTimeMetric) {
    let message = `<p>Для цієї вправи заплановано ${numSets} підход(и/ів).<br>`;
    message += `Тренер не вказав деталей по повтореннях, вазі або часу.<br>`;
    message += `Ви можете просто позначити вправу виконаною (натиснувши "⚡️"), якщо це передбачає виконання без цих показників.</p>`;
    // У цьому випадку таблиця з інпутами не потрібна.
    // Кнопка "блискавка" має зберегти виконання без числових даних для reps/weights/time.
    return message;
  }

  let tableHeaderHTML = '<th>Підхід</th>';
  if (showRepsMetric) {
    tableHeaderHTML += '<th>Повторення</th>'; // Один стовпець для повторень
  }
  if (showWeightsMetric) {
    tableHeaderHTML += '<th>Вага</th>'; // Один стовпець для ваги
  }
  if (showTimeMetric) {
    tableHeaderHTML += '<th>Час</th>'; // Один стовпець для часу
  }

  let setsTableHTML = `<table class="exercise-sets-table editable" data-num-sets="${numSets}">
                        <thead><tr>${tableHeaderHTML}</tr></thead>
                        <tbody>`;

  for (let i = 0; i < numSets; i++) {
    const setNumber = i + 1;
    let rowHTML = `<td>${setNumber}</td>`;

    // Комірка для Повторень (якщо метрика релевантна)
    if (showRepsMetric) {
      const planRepDisplay =
        plannedReps[i] !== null && plannedReps[i] !== undefined
          ? plannedReps[i]
          : '--';
      rowHTML += `<td class="editable-cell editable-reps" data-set-index="${i}">
                            <span class="set-value set-reps-value">${planRepDisplay}</span>
                            <select class="edit-select reps-edit-select" style="display: none;">${USER_REPS_OPTIONS}</select>
                        </td>`;
    }

    // Комірка для Ваги (якщо метрика релевантна)
    if (showWeightsMetric) {
      const planWeightVal = plannedWeights[i]; // Отримуємо значення планової ваги
      // ФОРМУЄМО РЯДОК ДЛЯ ВІДОБРАЖЕННЯ З ОДИНИЦЯМИ "кг"
      const planWeightDisplay =
        planWeightVal !== null && planWeightVal !== undefined
          ? `${planWeightVal} кг` // Якщо значення існує, додаємо " кг"
          : '--'; // Інакше показуємо "--"
      rowHTML += `<td class="editable-cell editable-weight" data-set-index="${i}">
                            <span class="set-value set-weight-value">${planWeightDisplay}</span>
                            <select class="edit-select weight-edit-select" style="display: none;">${USER_WEIGHT_OPTIONS}</select>
                        </td>`;
    }

    // Комірка для Часу (якщо метрика релевантна)
    if (showTimeMetric) {
      const planTimeVal = plannedTime[i];
      const planTimeDisplay =
        planTimeVal !== null && planTimeVal !== undefined
          ? `${planTimeVal} сек`
          : '--';
      rowHTML += `<td class="editable-cell editable-time" data-set-index="${i}">
                            <span class="set-value set-time-value">${planTimeDisplay}</span>
                            <select class="edit-select time-edit-select" style="display: none;">${USER_TIME_OPTIONS}</select>
                        </td>`;
    }
    setsTableHTML += `<tr>${rowHTML}</tr>`;
  }
  setsTableHTML += `</tbody>`; // Закриваємо тіло таблиці

  // --- ПОЧАТОК НОВОГО БЛОКУ: Додаємо кнопки керування підходами ---
  if (!isCompleted) {
    setsTableHTML += `<tfoot><tr><td colspan="${colspanValue}">`;
    setsTableHTML += `
          <div class="sets-actions">
              <button class="add-set-btn green-btn" title="Додати підхід" data-plan-id="${planId}" data-exercise-id="${exercise.id}">+</button>
      `;
    // Логіка для кнопки видалення залишається такою ж
    if (numSets > originalSetCount) {
      setsTableHTML += `
              <button class="remove-set-btn red-btn" title="Видалити останній підхід" data-plan-id="${planId}" data-exercise-id="${exercise.id}">-</button>
          `;
    }
    setsTableHTML += `</div>`;
  }
  // --- КІНЕЦЬ НОВОГО БЛОКУ ---

  setsTableHTML += `</table>`; // Закриваємо саму таблицю

  return `<div class="table-scroll-wrapper">${setsTableHTML}</div>`;
}

// Функція для додавання обробників редагування до комірок таблиці
/**
 * Додає обробники подій для редагування повторень, ваги та часу в таблиці вправи.
 * @param {HTMLElement} exerciseDiv - DOM-елемент блоку вправи.
 */
function addEditListenersToExercise(exerciseDiv) {
  // Функція-хелпер для налаштування комірки
  function setupEditableCell(
    cellSelector,
    valueClass,
    selectClass,
    preferenceType
  ) {
    // Важливо: querySelectorAll на exerciseDiv, щоб працювати тільки з поточною вправою
    exerciseDiv.querySelectorAll(cellSelector).forEach((cell) => {
      const valueSpan = cell.querySelector(valueClass);
      const editSelect = cell.querySelector(selectClass);
      if (!valueSpan || !editSelect) {
        // Якщо елементи не знайдені (наприклад, стовпець не був згенерований),
        // то для цього типу показника обробники не додаються. Це нормально.
        console.warn(
          `Елементи для ${cellSelector} не знайдені у вправі ID: ${exerciseDiv.dataset.exerciseId}`
        );
        return;
      }

      // Початкове заповнення select зі span (якщо потрібно при першому кліку)
      // valueSpan.textContent вже має містити планове значення або '--'
      // editSelect.value = valueSpan.textContent.replace(...).trim() === '--' ? "" : ... ;

      cell.addEventListener('click', (e) => {
        if (e.target.tagName === 'SELECT') return; // Не реагуємо на клік по самому селекту

        // Ховаємо всі інші селекти в цій вправі
        exerciseDiv.querySelectorAll('.edit-select').forEach((s) => {
          if (s !== editSelect) s.style.display = 'none';
        });
        exerciseDiv.querySelectorAll('.set-value').forEach((sp) => {
          if (sp !== valueSpan) sp.style.display = 'inline';
        });

        valueSpan.style.display = 'none';
        editSelect.style.display = 'inline-block';

        // Встановлюємо поточне значення span в select
        let currentValueForSelect = valueSpan.textContent.trim();
        if (preferenceType === 'weight') {
          currentValueForSelect = currentValueForSelect
            .replace(/\s*кг$/, '')
            .trim();
        } else if (preferenceType === 'time') {
          currentValueForSelect = currentValueForSelect
            .replace(/\s*сек$/, '')
            .trim();
        }
        editSelect.value =
          currentValueForSelect === '--' ? '' : currentValueForSelect;

        editSelect.focus();
      });

      editSelect.addEventListener('change', async () => {
        const newValueInSelect = editSelect.value; // Значення з селекта, що змінився ("" якщо обрано "--")
        const displayValue = newValueInSelect === '' ? '--' : newValueInSelect;

        // Оновлюємо текстовий вміст span
        let textForSpan = displayValue;
        if (displayValue !== '--') {
          if (preferenceType === 'time') textForSpan += ' сек';
          else if (preferenceType === 'weight') textForSpan += ' кг';
        }
        valueSpan.textContent = textForSpan;

        // Ховаємо select, показуємо span
        editSelect.style.display = 'none';
        valueSpan.style.display = 'inline';

        // --- ЗБІР ДАНИХ ДЛЯ ОНОВЛЕННЯ ПЕРЕВАГ ---
        const gifId = exerciseDiv.dataset.gifId;
        const exerciseTable = exerciseDiv.querySelector(
          '.exercise-sets-table.editable'
        );
        // Надійне отримання numSets з data-атрибута таблиці,
        // який встановлюється в generateEditableSetsTableHTML
        const numSets = exerciseTable
          ? parseInt(exerciseTable.dataset.numSets) || 0
          : 0;

        if (!gifId || numSets === 0) {
          console.error(
            'addEditListenersToExercise: gifId або numSets не визначені.',
            { gifId, numSets }
          );
          alert(
            'Помилка: Неможливо зберегти дані, відсутня інформація про вправу.'
          );
          return;
        }

        // Ініціалізуємо масиви null-ами потрібної довжини
        let collectedReps = Array(numSets).fill(null);
        let collectedWeights = Array(numSets).fill(null);
        let collectedTime = Array(numSets).fill(null);

        // Збираємо дані з усіх видимих стовпців
        const repsValueSpans = exerciseDiv.querySelectorAll(
          '.editable-reps .set-reps-value'
        );
        if (repsValueSpans.length > 0) {
          // Якщо стовпець повторень існує
          collectedReps = Array.from(repsValueSpans).map((span, index) => {
            const text = span.textContent.trim();
            return text === '--' ? null : parseInt(text);
          });
        } // Якщо repsValueSpans.length === 0, collectedReps залишається Array(numSets).fill(null)

        const weightsValueSpans = exerciseDiv.querySelectorAll(
          '.editable-weight .set-weight-value'
        );
        if (weightsValueSpans.length > 0) {
          // Якщо стовпець ваги існує
          collectedWeights = Array.from(weightsValueSpans).map(
            (span, index) => {
              const text = span.textContent.replace(/\s*кг$/, '').trim();
              return text === '--' ? null : parseInt(text);
            }
          );
        }

        const timeValueSpans = exerciseDiv.querySelectorAll(
          '.editable-time .set-time-value'
        );
        if (timeValueSpans.length > 0) {
          // Якщо стовпець часу існує
          collectedTime = Array.from(timeValueSpans).map((span, index) => {
            const text = span.textContent.replace(/\s*сек$/, '').trim();
            return text === '--' ? null : parseInt(text);
          });
        }

        console.log(
          'Дані, зібрані для PUT (з addEditListenersToExercise, після зміни селекта):',
          { gifId, collectedReps, collectedWeights, collectedTime, numSets }
        );

        // Викликаємо оновлення переваг
        await updateExercisePreference(
          gifId,
          collectedReps,
          collectedWeights,
          collectedTime,
          cell
        );
      });

      editSelect.addEventListener('blur', () => {
        // Якщо користувач клацнув повз, не змінивши значення,
        // просто ховаємо select і показуємо span (його textContent вже оновлений або залишився старим)
        editSelect.style.display = 'none';
        valueSpan.style.display = 'inline';
        // Немає потреби тут знову встановлювати editSelect.value,
        // бо він вже має бути актуальним або ми його не змінювали.
      });
    });
  }

  // Викликаємо налаштування для кожного типу редагованої комірки
  setupEditableCell(
    '.editable-reps',
    '.set-reps-value',
    '.reps-edit-select',
    'reps'
  );
  setupEditableCell(
    '.editable-weight',
    '.set-weight-value',
    '.weight-edit-select',
    'weight'
  );
  setupEditableCell(
    '.editable-time',
    '.set-time-value',
    '.time-edit-select',
    'time'
  );
}

/**
 * Обробник кнопки "Назад до списку тренувань".
 */
const backButton = document.getElementById('back-to-workout-list');
if (backButton) {
  backButton.addEventListener('click', () => {
    const detailsContainer = document.getElementById(
      'workout-details-container'
    );
    const listContainer = document.getElementById('workout-list-container');
    if (detailsContainer) detailsContainer.style.display = 'none';
    if (listContainer) listContainer.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' }); // Плавний скрол вгору
    // Очищаємо статус деталей
    const detailsStatusDiv = document.getElementById('workout-details-status');
    if (detailsStatusDiv) detailsStatusDiv.innerText = '';
  });
}

/**
 * Обробник кнопки "Назад до списку тренувань 2 (під фідбеком)".
 */
const backButton2 = document.getElementById('back-to-workout-list2');
if (backButton) {
  backButton2.addEventListener('click', () => {
    const detailsContainer = document.getElementById(
      'workout-details-container'
    );
    const listContainer = document.getElementById('workout-list-container');
    if (detailsContainer) detailsContainer.style.display = 'none';
    if (listContainer) listContainer.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' }); // Плавний скрол вгору
    // Очищаємо статус деталей
    const detailsStatusDiv = document.getElementById('workout-details-status');
    if (detailsStatusDiv) detailsStatusDiv.innerText = '';
  });
}

/**
 * Відправляє запит на оновлення переваг (виконаних даних).
 * @param {string|number} gifId ID GIF вправи.
 * @param {Array<number|null>} repsArray Масив значень повторень.
 * @param {Array<number|null>} weightsArray Масив значень ваги.
 * @param {Array<number|null>} timeArray Масив значень часу.
 * @param {HTMLElement | null} feedbackElement - Комірка для підсвітки.
 */
async function updateExercisePreference(
  gifId,
  repsArray,
  weightsArray,
  timeArray,
  feedbackElement = null
) {
  //console.log(`Виклик updateExercisePreference для GIF ID: ${gifId}`, { repsArray, weightsArray, timeArray, feedbackElement });

  if (!gifId) {
    /* ... помилка ... */ return Promise.reject(new Error('Немає ID вправи'));
  }

  // Перевіряємо, чи всі масиви є масивами і мають однакову довжину (якщо не порожні)
  const isValidArray = (arr) => Array.isArray(arr);
  if (
    !isValidArray(repsArray) ||
    !isValidArray(weightsArray) ||
    !isValidArray(timeArray) ||
    !(
      repsArray.length === weightsArray.length &&
      weightsArray.length === timeArray.length
    ) ||
    repsArray.length === 0
  ) {
    // Має бути хоча б один сет
    console.error(
      'Некоректні дані для оновлення переваг: масиви відсутні, порожні або різної довжини.'
    );
    // alert("Помилка: некоректні дані для збереження.");
    return Promise.reject(
      new Error('Некоректні дані для оновлення переваг (масиви)')
    );
  }

  try {
    const { data: updatedPreference, response } = await fetchWithAuth(
      `${baseURL}/exercises/preferences/${gifId}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          reps: repsArray,
          weights: weightsArray,
          time: timeArray, // NEW: Надсилаємо масив часу
        }),
      }
    );

    // ... (обробка відповіді та помилок, підсвітка - як у вашому коді, але врахуйте, що клас успіху/помилки тепер може бути і для 'time') ...
    if (!response.ok) {
      throw new Error(errorData.detail || `Помилка ${response.status}`);
    }

    // Оновлюємо нашу локальну "пам'ять"
    const exerciseDiv = feedbackElement?.closest('.exercise-item');
    const planId = document.getElementById('workout-details-container')?.dataset
      .currentPlanId;

    if (exerciseDiv && exerciseDiv.dataset.exerciseId && planId) {
      const exerciseId = exerciseDiv.dataset.exerciseId;
      const savedProgress = getInProgressWorkoutData(planId);

      savedProgress[exerciseId] = {
        reps: repsArray,
        weights: weightsArray,
        time: timeArray,
        sets: repsArray.length,
      };

      setInProgressWorkoutData(planId, savedProgress);
    }

    //console.log("Переваги успішно оновлено:", updatedPreference);

    // --- Зворотний зв'язок при УСПІХУ ---
    if (feedbackElement && feedbackElement instanceof HTMLElement) {
      const successClass = 'updated-success'; // ВИКОРИСТОВУЄМО ЗАВЖДИ ЦЕЙ КЛАС

      //console.log("Застосування класу успіху до комірки:", successClass, feedbackElement);
      feedbackElement.classList.add(successClass);
      setTimeout(() => {
        if (feedbackElement) {
          feedbackElement.classList.remove(successClass);
          //console.log("Клас успіху видалено:", successClass, feedbackElement);
        }
      }, 1500); // Тривалість підсвітки 1.5 секунди
    }
    return updatedPreference;
  } catch (error) {
    console.error('Помилка оновлення переваг:', error.message);

    // --- Зворотний зв'язок при ПОМИЛЦІ ---
    if (feedbackElement && feedbackElement instanceof HTMLElement) {
      const errorClass = 'updated-error'; // ВИКОРИСТОВУЄМО ЗАВЖДИ ЦЕЙ КЛАС

      console.error(
        'Застосування класу помилки до комірки:',
        errorClass,
        feedbackElement
      );
      feedbackElement.classList.add(errorClass);
      setTimeout(() => {
        if (feedbackElement) {
          feedbackElement.classList.remove(errorClass);
          //console.log("Клас помилки видалено:", errorClass, feedbackElement);
        }
      }, 1500); // Тривалість підсвітки 1.5 секунди
      // alert(`Помилка оновлення переваг: ${error.message}`); // Закоментовано, бо може бути надлишковим
    }
    return Promise.reject(error); // Прокидаємо помилку далі
  }
}

/**
 * MODIFIED: Обробляє клік на кнопку "Блискавка" ⚡️.
 * Зберігає переваги, запускає анімацію, чекає 2 секунди,
 * оновлює localStorage та замінює таблицю на read-only.
 */
async function handleSavePreferenceClick(event) {
  const button = event.currentTarget;
  const gifId = button.dataset.gifId;
  const exerciseDiv = button.closest('.exercise-item');
  const exerciseId = exerciseDiv?.dataset.exerciseId;

  const detailsContainer = document.getElementById('workout-details-container');
  const planId = detailsContainer?.dataset.currentPlanId;

  if (!gifId || !exerciseDiv || !exerciseId || !planId) {
    console.error(
      'handleSavePreferenceClick: Не вдалося отримати gifId, exerciseDiv, exerciseId або planId.',
      { gifId, exerciseId, planId }
    );
    alert('Внутрішня помилка: Не вдалося обробити виконання вправи.');
    return;
  }
  // Запобігаємо повторному кліку, поки йде обробка або якщо вже збережено (is-saved тут для анімації)
  if (button.classList.contains('is-saving') || button.disabled) return;

  button.disabled = true;
  button.classList.add('is-saving'); // Показати, що йде збереження (можна додати стиль для цього)

  // ... (Ваш код для визначення numSets та збору currentReps, currentWeights, currentTime залишається тут) ...
  const plannedReps = JSON.parse(exerciseDiv.dataset.plannedReps || '[]');
  const plannedWeights = JSON.parse(exerciseDiv.dataset.plannedWeights || '[]');
  const plannedTime = JSON.parse(exerciseDiv.dataset.plannedTime || '[]');

  const exerciseTable = exerciseDiv.querySelector(
    '.exercise-sets-table.editable'
  );
  let numSets = 0;
  if (exerciseTable && exerciseTable.dataset.numSets) {
    numSets = parseInt(exerciseTable.dataset.numSets);
  } else {
    numSets =
      plannedReps.length || plannedWeights.length || plannedTime.length || 0;
  }
  if (
    numSets === 0 &&
    (plannedReps.length > 0 ||
      plannedWeights.length > 0 ||
      plannedTime.length > 0)
  ) {
    numSets = Math.max(
      plannedReps.length,
      plannedWeights.length,
      plannedTime.length
    );
  }

  let currentReps = Array(numSets).fill(null);
  let currentWeights = Array(numSets).fill(null);
  let currentTime = Array(numSets).fill(null);

  const repsValueSpans = exerciseDiv.querySelectorAll(
    '.editable-reps .set-reps-value'
  );
  if (repsValueSpans.length > 0) {
    currentReps = Array.from(repsValueSpans).map((span) => {
      const text = span.textContent.trim();
      return text === '--' ? null : parseInt(text);
    });
  } else if (numSets > 0) {
    currentReps = Array(numSets).fill(null);
  }

  const weightsValueSpans = exerciseDiv.querySelectorAll(
    '.editable-weight .set-weight-value'
  );
  if (weightsValueSpans.length > 0) {
    currentWeights = Array.from(weightsValueSpans).map((span) => {
      const text = span.textContent.replace(/\s*кг$/, '').trim();
      return text === '--' ? null : parseInt(text);
    });
  } else if (numSets > 0) {
    currentWeights = Array(numSets).fill(null);
  }

  const timeValueSpans = exerciseDiv.querySelectorAll(
    '.editable-time .set-time-value'
  );
  if (timeValueSpans.length > 0) {
    currentTime = Array.from(timeValueSpans).map((span) => {
      const text = span.textContent.replace(/\s*сек$/, '').trim();
      return text === '--' ? null : parseInt(text);
    });
  } else if (numSets > 0) {
    currentTime = Array(numSets).fill(null);
  }

  if (
    numSets > 0 &&
    (currentReps.length !== numSets ||
      currentWeights.length !== numSets ||
      currentTime.length !== numSets)
  ) {
    console.error(
      'Критична помилка збору даних: фінальна довжина масивів не відповідає numSets.',
      { numSets, currentReps, currentWeights, currentTime }
    );
    alert('Внутрішня помилка: не вдалося коректно зібрати дані про виконання.');
    button.disabled = false;
    button.classList.remove('is-saving');
    return;
  }
  // --- Кінець збору даних ---

  try {
    // 1. Зберігаємо переваги (фактичні дані) на бекенді.
    if (
      numSets > 0 ||
      (numSets === 0 && false) /* ваша логіка для вправ без підходів */
    ) {
      await updateExercisePreference(
        gifId,
        currentReps,
        currentWeights,
        currentTime,
        null
      );
    } else if (numSets === 0) {
      //console.log(`handleSavePreferenceClick: numSets = 0 для GIF ID ${gifId}. updateExercisePreference не викликається, але вправу буде позначено як виконану локально.`);
    }

    // 2. Запускаємо CSS анімацію на кнопці
    button.classList.remove('is-saving'); // Прибираємо клас "збереження"
    button.classList.add('is-saved'); // Додаємо клас для CSS анімації "успішно збережено"

    // 3. Встановлюємо таймер на 2 секунди
    setTimeout(() => {
      // Код, який виконається ПІСЛЯ 2 секунд:

      // а. Оновлюємо localStorage
      const completedExercisesDataKey = `completedPlan_${planId}`;
      const completedExercisesMap =
        JSON.parse(localStorage.getItem(completedExercisesDataKey)) || {};
      completedExercisesMap[exerciseId] = {
        plannedReps: plannedReps,
        plannedWeights: plannedWeights,
        plannedTime: plannedTime,
        completedReps: currentReps,
        completedWeights: currentWeights,
        completedTime: currentTime,
      };
      localStorage.setItem(
        completedExercisesDataKey,
        JSON.stringify(completedExercisesMap)
      );
      //console.log(`[handleSavePreferenceClick] Вправу ${exerciseId} (після анімації) позначено виконаною в localStorage.`);

      // б. Замінюємо таблицю на read-only
      const setsTableContainer = exerciseDiv.querySelector(
        '.sets-table-container'
      );
      if (setsTableContainer) {
        setsTableContainer.innerHTML = generateUserReadOnlyTableHTML(
          plannedReps,
          plannedWeights,
          plannedTime,
          currentReps,
          currentWeights,
          currentTime
        );
        //console.log(`[handleSavePreferenceClick] Таблицю для вправи ${exerciseId} (після анімації) замінено на read-only.`);
      }

      // в. Оновлюємо решту UI (ховаємо кнопку, додаємо галочку тощо)
      button.classList.remove('is-saved'); // Прибираємо клас анімації (якщо вона не 'forwards')
      button.style.display = 'none';
      const infoSpan = button.previousElementSibling;
      if (infoSpan && infoSpan.classList.contains('save-preference-info')) {
        infoSpan.style.display = 'none';
      }
      exerciseDiv.classList.add('exercise-completed-visual');
      const header = exerciseDiv.querySelector('.exercise-header');
      if (header && !header.querySelector('.exercise-checkmark')) {
        const checkmark = document.createElement('span');
        checkmark.classList.add('exercise-checkmark');
        checkmark.title = 'Вправу виконано';
        checkmark.textContent = ' ✔️';
        header.appendChild(checkmark);
      }

      button.disabled = false; // Розблоковуємо кнопку (хоча вона вже прихована)
    }, 800); // Затримка 800 мс = 0,8 секунди
  } catch (error) {
    console.error(
      'Помилка під час збереження стану вправи (клік на блискавку):',
      error
    );
    const errorMsg =
      error && error.message ? error.message : 'Невідома помилка збереження';
    const statusDisplayLocation =
      exerciseDiv.querySelector('.save-preference-info') ||
      document.getElementById('workout-details-status');

    if (statusDisplayLocation) {
      // ... (ваш код обробки помилки для statusDisplayLocation) ...
      const originalText = statusDisplayLocation.classList.contains(
        'save-preference-info'
      )
        ? 'Виконав вправу - тисни блискавку:'
        : '';
      const originalColor = statusDisplayLocation.style.color || '';
      statusDisplayLocation.textContent = `Помилка: ${errorMsg}`;
      statusDisplayLocation.style.color = 'red';
      setTimeout(() => {
        if (
          originalText &&
          statusDisplayLocation.textContent.startsWith('Помилка:')
        ) {
          statusDisplayLocation.textContent = originalText;
        }
        statusDisplayLocation.style.color = originalColor;
      }, 4000);
    } else {
      alert(`Помилка збереження даних для вправи: ${errorMsg}`);
    }

    // Важливо зняти 'is-saving' та розблокувати кнопку у випадку помилки
    button.disabled = false;
    button.classList.remove('is-saving');
    // Клас 'is-saved' не додавався, якщо була помилка до setTimeout
  }
  // finally блок тут не потрібен для button.disabled, бо setTimeout асинхронний
  // Якщо updateExercisePreference викидає помилку, ми потрапляємо в catch.
  // Якщо ні, то button.disabled = false; відбудеться всередині setTimeout
}

// ==========================================================
// === НОВІ ФУНКЦІЇ ДЛЯ ПОСЛІДОВНОГО ТАЙМЕРА РОБОТИ/ВІДПОЧИНКУ ===
// ==========================================================

/**
 * ФІНАЛЬНА ВЕРСІЯ 3.0: Запускає простий таймер, стійкий та з коректним стартом.
 */
function startSimpleRestTimer(duration) {
  clearInterval(restTimerInterval);
  workTimerController.isActive = false;

  restTimerModal.dataset.timerType = 'simple';
  initialTimerDuration = duration;

  updateTimerUI('resting');

  // МИТТЄВО встановлюємо правильний час на циферблаті
  timerDisplay.textContent = formatSecondsToMMSS(duration);

  const startTime = Date.now();
  const totalDurationMs = duration * 1000;

  restTimerInterval = setInterval(() => {
    const elapsedTime = Date.now() - startTime;
    const timeLeftMs = totalDurationMs - elapsedTime;
    const timeLeftSec = Math.round(timeLeftMs / 1000);

    timerDisplay.textContent = formatSecondsToMMSS(
      timeLeftSec > 0 ? timeLeftSec : 0
    );

    if (
      timeLeftSec === 10 ||
      timeLeftSec === 3 ||
      timeLeftSec === 2 ||
      timeLeftSec === 1
    ) {
      playTimerSound('tick');
    } else if (timeLeftMs <= 0) {
      clearInterval(restTimerInterval);
      playTimerSound('finish2', closeRestTimerModal);
    }
  }, 1000);
}

/**
 * ФІНАЛЬНА ВЕРСІЯ: Головна функція, що запускає послідовність.
 */
function startWorkAndRestSequence(workTimes, restTime) {
  // Явно позначаємо тип таймера
  restTimerModal.dataset.timerType = 'sequence';

  workTimerController = {
    isActive: true,
    stage: 'preparing',
    currentSet: 0,
    totalSets: workTimes.length,
    workTimes: workTimes,
    restTime: restTime,
    onComplete: closeRestTimerModal,
  };

  runNextStage();
}

/**
 * Керує переходами між етапами (машина станів).
 */
function runNextStage() {
  const ctrl = workTimerController;
  if (!ctrl.isActive) return;

  switch (ctrl.stage) {
    case 'preparing':
      updateTimerUI('preparing');
      // ВИПРАВЛЕНО: Чітко передаємо 'finish2' для підготовки
      startCountdown(
        15,
        () => {
          ctrl.stage = 'working';
          ctrl.currentSet = 1;
          runNextStage();
        },
        'finish2'
      );
      break;

    case 'working':
      if (ctrl.currentSet > ctrl.totalSets) {
        ctrl.onComplete();
        break;
      }
      updateTimerUI('working', ctrl.currentSet);
      const workDuration = ctrl.workTimes[ctrl.currentSet - 1];
      // ВИПРАВЛЕНО: Чітко передаємо 'finish1' для роботи (підходу)
      startCountdown(
        workDuration,
        () => {
          if (ctrl.currentSet === ctrl.totalSets) {
            ctrl.onComplete();
          } else {
            ctrl.stage = 'resting';
            runNextStage();
          }
        },
        'finish1'
      );
      break;

    case 'resting':
      updateTimerUI('resting');
      // ВИПРАВЛЕНО: Чітко передаємо 'finish2' для відпочинку
      startCountdown(
        ctrl.restTime,
        () => {
          ctrl.stage = 'working';
          ctrl.currentSet++;
          runNextStage();
        },
        'finish2'
      );
      break;
  }
}

/**
 * Оновлює інтерфейс модального вікна (колір, текст).
 * @param {string} stage - Назва поточного етапу ('preparing', 'working', 'resting').
 * @param {number|null} setNumber - Номер поточного підходу (тільки для етапу 'working').
 */
function updateTimerUI(stage, setNumber = null) {
  const modal = restTimerModal;
  if (!modal) return;

  // Скидаємо всі класи станів
  modal.classList.remove('is-resting', 'is-preparing', 'is-working');

  switch (stage) {
    case 'preparing':
      modal.classList.add('is-preparing');
      timerStatusText.textContent = 'ПІДГОТОВКА';
      break;
    case 'working':
      modal.classList.add('is-working');
      timerStatusText.textContent = `${setNumber} ПІДХІД`;
      break;
    case 'resting':
      modal.classList.add('is-resting');
      timerStatusText.textContent = 'ВІДПОЧИНОК';
      break;
  }
}

/**
 * ФІНАЛЬНА ВЕРСІЯ 3.0: Універсальний таймер, стійкий та спрощений.
 */
function startCountdown(
  duration,
  onCompleteCallback,
  finishSoundType = 'finish1'
) {
  clearInterval(restTimerInterval);

  // МИТТЄВО встановлюємо правильний час на циферблаті
  timerDisplay.textContent = formatSecondsToMMSS(duration);

  const startTime = Date.now();
  const totalDurationMs = duration * 1000;

  restTimerInterval = setInterval(() => {
    // Зайву логіку з lastTimerRunId видалено
    const elapsedTime = Date.now() - startTime;
    const timeLeftMs = totalDurationMs - elapsedTime;
    const timeLeftSec = Math.round(timeLeftMs / 1000);

    timerDisplay.textContent = formatSecondsToMMSS(
      timeLeftSec > 0 ? timeLeftSec : 0
    );

    if (
      timeLeftSec === 10 ||
      timeLeftSec === 3 ||
      timeLeftSec === 2 ||
      timeLeftSec === 1
    ) {
      playTimerSound('tick');
    } else if (timeLeftMs <= 0) {
      clearInterval(restTimerInterval);
      playTimerSound(finishSoundType, onCompleteCallback);
    }
  }, 1000);
}

/**
 * ОНОВЛЕНО: Вибирає потрібний буфер і викликає playSound.
 */
function playTimerSound(type, onSoundEnd = null) {
  unlockAudioContext(); // Про всяк випадок "будимо" контекст
  switch (type) {
    case 'tick':
      playSound(tickBuffer);
      break;
    case 'finish1':
      playSound(finishBuffer, onSoundEnd);
      break;
    case 'finish2':
      playSound(finish2Buffer, onSoundEnd);
      break;
    default:
      if (onSoundEnd) onSoundEnd();
      break;
  }
}

/**
 * ОНОВЛЕНО: Просто відкриває модальне вікно та синхронізує іконку звуку.
 */
function openRestTimerModal() {
  if (!restTimerModal) return;

  if (timerSoundToggleBtn) {
    timerSoundToggleBtn.classList.toggle('muted', !areTimerSoundsEnabled);
    timerSoundToggleBtn.title = areTimerSoundsEnabled
      ? 'Вимкнути звук'
      : 'Увімкнути звук';
  }

  restTimerModal.style.display = 'flex';
}

/**
 * ФІНАЛЬНА ВЕРСІЯ: Коректно закриває модальне вікно таймера.
 */
function closeRestTimerModal() {
  if (!restTimerModal) return;

  // Повертаємо текст за замовчуванням на випадок, якщо вікно відкриють знову
  if (timerStatusText) timerStatusText.textContent = 'ВІДПОЧИНОК';

  // Ховаємо модальне вікно
  restTimerModal.style.display = 'none';

  // ВАЖЛИВО: Зупиняємо будь-який активний інтервал відліку
  clearInterval(restTimerInterval);

  // Старі рядки з .pause() та .currentTime = 0 видалено, бо вони більше не потрібні
  // для Web Audio API.
}
// === КІНЕЦЬ БЛОКУ ФУНКЦІЙ ТАЙМЕРА Відпочинку ===

// --- Керування вкладками ---
function openTab(event, tabName) {
  const tabs = document.getElementsByClassName('tab-content');
  for (let i = 0; i < tabs.length; i++) {
    tabs[i].style.display = 'none';
  }
  const links = document.getElementsByClassName('tab-link');
  for (let i = 0; i < links.length; i++) {
    links[i].classList.remove('active');
  }

  const currentTab = document.getElementById(tabName);
  if (currentTab) {
    currentTab.style.display = 'block';
  } else {
    console.error(`Елемент з ID '${tabName}' не знайдено!`);
    return;
  }

  if (event && event.currentTarget) {
    event.currentTarget.classList.add('active');
  }

  // Завантажуємо дані тільки при відкритті відповідної вкладки
  if (tabName === 'profile') {
    // --- НОВА ЛОГІКА ДЛЯ ВКЛАДКИ ПРОФІЛЬ ---
    const defaultSubTabButton = document.querySelector(
      '#profile .sub-tab-link[onclick*="profile-view"]'
    );
    if (defaultSubTabButton) {
      // Імітуємо клік на першу під-вкладку ("Мій профіль")
      openProfileSubTab({ currentTarget: defaultSubTabButton }, 'profile-view');
    } else {
      console.error("Кнопка під-вкладки 'Мій профіль' не знайдена.");
    }
  } else if (tabName === 'progress') {
    loadProgressData();
  } else if (tabName === 'ratings') {
    // Знаходимо і "клікаємо" на першу під-вкладку, щоб завантажити її вміст
    const defaultSubTabButton = document.querySelector(
      '#ratings .sub-tab-link'
    );
    if (defaultSubTabButton) {
      openRatingsSubTab(
        { currentTarget: defaultSubTabButton },
        'leaderboard-total'
      );
    }
  } else if (tabName === 'workouts') {
    // Показуємо вигляд списку за замовчуванням
    showUserWorkoutView('list');

    // Завантажуємо список тренувань
    loadWorkoutList();

    // Перевіряємо, чи потрібно показати кнопку створення тренування
    checkAndDisplayIndependentFeatures();
  } else if (tabName === 'subscription') {
    loadSubscriptionData();
  } else if (tabName === 'notifications') {
    loadAndDisplayNotifications();
  } else if (tabName === 'plan') {
    loadAndDisplayWorkoutPlans();
  }
  // Вкладка "logout" не потребує обробки тут, оскільки вона має власну кнопку з обробником
}

/**
 * Відкриває під-вкладку всередині розділу "Профіль".
 * @param {Event} event - Подія кліку.
 * @param {string} subTabName - ID контенту під-вкладки, яку потрібно відкрити.
 */
function openProfileSubTab(event, subTabName) {
  const profileTabContent = document.getElementById('profile');
  if (!profileTabContent) return;

  // Отримуємо всі елементи контенту під-вкладок та кнопки
  let subContents = profileTabContent.querySelectorAll('.profile-sub-content');
  let subTabLinks = profileTabContent.querySelectorAll('.sub-tab-link');

  // Ховаємо весь контент під-вкладок та знімаємо активний клас з кнопок
  subContents.forEach(function (content) {
    content.style.display = 'none';
    content.classList.remove('active-sub-content');
  });
  subTabLinks.forEach(function (link) {
    link.classList.remove('active');
  });

  // Показуємо обраний контент під-вкладки та робимо активною відповідну кнопку
  const activeSubContent = document.getElementById(subTabName);
  if (activeSubContent) {
    activeSubContent.style.display = 'block';
    activeSubContent.classList.add('active-sub-content');
  }
  if (event && event.currentTarget) {
    event.currentTarget.classList.add('active');
  }

  // Завантаження даних для відповідної під-вкладки
  if (subTabName === 'profile-view') {
    loadAndDisplayUserProfileViewData(); // Функція для завантаження та відображення даних "Мій профіль"
  } else if (subTabName === 'profile-edit') {
    loadProfileDataForEditForm(); // Функція для завантаження даних у форму редагування
  } else if (subTabName === 'profile-community') {
    loadCommunityUsers(); // Завантажуємо список при першому відкритті
    const communityContainer = document.getElementById('profile-community');
    // Очистимо попередній обраний профіль, якщо він був
    const selectedUserProfileDiv = document.getElementById(
      'community-selected-user-profile'
    );
    if (selectedUserProfileDiv) {
      selectedUserProfileDiv.innerHTML = '';
      selectedUserProfileDiv.style.display = 'none';
    }
  }
}

// === ФІНАЛЬНИЙ ОБРОБНИК ДЛЯ ВСІХ ДІЙ В МОДАЛЬНОМУ ВІКНІ ТАЙМЕРА ===
if (restTimerModal) {
  restTimerModal.addEventListener('click', (event) => {
    // 1. Клік по кнопці "Звук"
    if (event.target.closest('#timer-sound-toggle-btn')) {
      // Інвертуємо стан
      areTimerSoundsEnabled = !areTimerSoundsEnabled;
      // Зберігаємо вибір користувача в пам'ять браузера
      localStorage.setItem('timerSoundsEnabled', areTimerSoundsEnabled);
      // Оновлюємо вигляд кнопки
      timerSoundToggleBtn.classList.toggle('muted', !areTimerSoundsEnabled);
      timerSoundToggleBtn.title = areTimerSoundsEnabled
        ? 'Вимкнути звук'
        : 'Увімкнути звук';
      return;
    }

    // 2. Клік по кнопці "Згорнути"
    if (event.target.closest('#timer-minimize-btn')) {
      restTimerModal.classList.toggle('minimized');
      return;
    }

    // 3. Клік для розгортання вікна
    if (restTimerModal.classList.contains('minimized')) {
      if (!event.target.closest('.timer-controls')) {
        restTimerModal.classList.remove('minimized');
      }
      return;
    }

    // 4. Клік по кнопці "Перезапуск"
    if (event.target.closest('#timer-restart-btn')) {
      if (restTimerModal.dataset.timerType === 'sequence') {
        runNextStage();
      } else {
        startSimpleRestTimer(initialTimerDuration);
      }
    }

    // 5. Клік по кнопці "Закрити"
    if (event.target.closest('#timer-close-btn')) {
      workTimerController.isActive = false;
      clearInterval(restTimerInterval);
      restTimerModal.classList.remove('minimized');
      closeRestTimerModal();
    }
  });
}

// --- Вихід з системи ---
const logoutButton = document.getElementById('confirm-logout');
if (logoutButton) {
  logoutButton.addEventListener('click', async function () {
    const token = getAccessToken(); // Використовуємо access token для запиту logout
    const refreshTokenExists = !!getRefreshToken(); // Перевіряємо, чи є рефреш токен для виклику бекенду

    // Викликаємо бекенд ТІЛЬКИ якщо є токени (особливо рефреш, бо бекенд видаляє його хеш)
    if (token && refreshTokenExists) {
      try {
        // Використовуємо fetchWithAuth, щоб обробити можливий 401, хоча це малоймовірно при виході
        const { data, response } = await fetchWithAuth(`${baseURL}/logout`, {
          method: 'POST',
          // Не потрібно body
        });

        if (!response.ok && response.status !== 401) {
          console.warn(
            `Помилка відповіді сервера при виході: ${response.status}`
          );
        }
      } catch (error) {
        // Якщо fetchWithAuth викинув помилку (напр., невдале оновлення), логуємо її
        console.error('Помилка під час запиту /logout:', error);
      }
    } else {
      //console.log("Вихід без виклику бекенду (токени відсутні).");
    }

    // Завжди очищуємо токени локально і оновлюємо UI
    updateTabAccessibility(false);
    clearTokens(); // Видаляємо обидва токени з localStorage
    // Видаляємо старі прапорці адміна (якщо вони були)
    localStorage.removeItem('is_admin');
    localStorage.removeItem('admin_phone');

    alert('Ви успішно вийшли! Повертайтеся до нас скоріше =)');
    // Оновлюємо видимість, щоб показати форму входу
    updateVisibility();
    // Перезавантаження сторінки або перенаправлення (опціонально)
    window.location.href = '/'; // Перенаправляємо на головну
  });
}

/**
 * Обробляє клік на кнопку "+ Додати підхід".
 * @param {Event} event - Подія кліку.
 */
async function handleAddSetClick(event) {
  const button = event.currentTarget;
  const planId = button.dataset.planId;
  const exerciseId = button.dataset.exerciseId;

  if (!planId || !exerciseId) {
    alert('Помилка: не вдалося визначити ID тренування або вправи.');
    return;
  }
  button.disabled = true;

  try {
    const { data: updatedPlan, response } = await fetchWithAuth(
      `${baseURL}/training_plans/${planId}/exercises/${exerciseId}/add-set`,
      { method: 'POST' }
    );

    if (!response.ok) {
      throw new Error(updatedPlan.detail || 'Не вдалося додати підхід.');
    }

    const savedProgress = getInProgressWorkoutData(planId);
    const updatedExerciseFromServer = updatedPlan.exercises.find(
      (ex) => ex.id == exerciseId
    );

    if (updatedExerciseFromServer) {
      // ВИПРАВЛЕНО: Беремо дані з "пам'яті", АБО з ОРИГІНАЛЬНОГО плану, якщо їх там немає
      const exerciseDataToModify =
        savedProgress[exerciseId] ||
        JSON.parse(
          JSON.stringify(
            originalPlanDataForDetails.exercises.find(
              (ex) => ex.id == exerciseId
            )
          )
        );

      exerciseDataToModify.reps.push(null);
      exerciseDataToModify.weights.push(null);
      exerciseDataToModify.time.push(null);
      exerciseDataToModify.sets = updatedExerciseFromServer.sets;

      savedProgress[exerciseId] = exerciseDataToModify;
      setInProgressWorkoutData(planId, savedProgress);
    }

    // ВИПРАВЛЕНО: "Змішуємо" відповідь сервера з "пам'яттю" перед відображенням
    updatedPlan.exercises.forEach((exercise) => {
      if (savedProgress[exercise.id]) {
        const memory = savedProgress[exercise.id];
        exercise.reps = memory.reps;
        exercise.weights = memory.weights;
        exercise.time = memory.time;
        exercise.sets = memory.sets;
      }
    });

    renderWorkoutDetailsFromData(updatedPlan);
  } catch (error) {
    alert(`Помилка додавання підходу: ${error.message}`);
    button.disabled = false;
  }
}

/**
 * Обробляє клік на кнопку "- Видалити підхід".
 * @param {Event} event - Подія кліку.
 */
async function handleRemoveLastSetClick(event) {
  const button = event.currentTarget;
  const planId = button.dataset.planId;
  const exerciseId = button.dataset.exerciseId;

  if (!planId || !exerciseId) {
    alert('Помилка: не вдалося визначити ID тренування або вправи.');
    return;
  }
  button.disabled = true;

  try {
    const { data: updatedPlan, response } = await fetchWithAuth(
      `${baseURL}/training_plans/${planId}/exercises/${exerciseId}/remove-last-set`,
      { method: 'DELETE' }
    );

    if (!response.ok) {
      throw new Error(
        updatedPlan.detail || `Помилка сервера: ${response.status}`
      );
    }

    const savedProgress = getInProgressWorkoutData(planId);
    const updatedExerciseFromServer = updatedPlan.exercises.find(
      (ex) => ex.id == exerciseId
    );

    if (updatedExerciseFromServer) {
      // ВИПРАВЛЕНО: Беремо дані з "пам'яті", АБО з ОРИГІНАЛЬНОГО плану
      const exerciseDataToModify =
        savedProgress[exerciseId] ||
        JSON.parse(
          JSON.stringify(
            originalPlanDataForDetails.exercises.find(
              (ex) => ex.id == exerciseId
            )
          )
        );

      if (exerciseDataToModify.reps.length > 0) exerciseDataToModify.reps.pop();
      if (exerciseDataToModify.weights.length > 0)
        exerciseDataToModify.weights.pop();
      if (exerciseDataToModify.time.length > 0) exerciseDataToModify.time.pop();
      exerciseDataToModify.sets = updatedExerciseFromServer.sets;

      savedProgress[exerciseId] = exerciseDataToModify;
      setInProgressWorkoutData(planId, savedProgress);
    }

    // ВИПРАВЛЕНО: "Змішуємо" відповідь сервера з "пам'яттю" перед відображенням
    updatedPlan.exercises.forEach((exercise) => {
      if (savedProgress[exercise.id]) {
        const memory = savedProgress[exercise.id];
        exercise.reps = memory.reps;
        exercise.weights = memory.weights;
        exercise.time = memory.time;
        exercise.sets = memory.sets;
      }
    });

    renderWorkoutDetailsFromData(updatedPlan);
  } catch (error) {
    alert(`Помилка видалення підходу: ${error.message}`);
    button.disabled = false;
  }
}

// ==========================================================
// === ОСНОВНИЙ БЛОК ЛОГІКИ ТА ІНІЦІАЛІЗАЦІЇ ===
// ==========================================================

/**
 * Перевіряє, чи авторизований користувач.
 * ВЕРСІЯ ДЛЯ ДІАГНОСТИКИ.
 */
// Чиста версія для робочого сайту
function isAuthorized() {
  const token = getAccessToken();
  // Перевіряємо, що токен - це осмислений рядок, а не null чи "undefined"
  return token && typeof token === 'string' && token.length > 10;
}

/**
 * Обробник форми ручного входу.
 */
const loginForm = document.getElementById('login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const phoneInput = loginForm.querySelector('input[name="phone"]');
    const passwordInput = loginForm.querySelector('input[name="password"]');
    const responseDiv = document.getElementById('login-response');

    const phone = phoneInput ? phoneInput.value : null;
    const password = passwordInput ? passwordInput.value : null;

    if (!phone || !password) {
      if (responseDiv)
        responseDiv.innerText = 'Будь ласка, введіть номер телефону та пароль.';
      return;
    }
    if (responseDiv) responseDiv.innerText = 'Вхід...';

    try {
      const response = await fetch(`${baseURL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password }),
      });
      const data = await response.json();
      if (response.ok) {
        setTokens(data.access_token, data.refresh_token, data.expires_in);
        if (responseDiv) responseDiv.innerText = 'Успішний вхід! :)';

        // Прибираємо фокус з полів вводу
        if (phoneInput) phoneInput.blur();
        if (passwordInput) passwordInput.blur();

        // Перезавантажуємо сторінку з міткою, що вхід був ручним
        window.location.href = window.location.pathname + '?login=success';
      } else {
        if (responseDiv)
          responseDiv.innerText = data.detail || 'Помилка входу...';
      }
    } catch (error) {
      console.error('Помилка:', error);
      if (responseDiv) responseDiv.innerText = 'Помилка запиту...';
    }
  });
}

/**
 * Ініціалізує весь функціонал відновлення пароля через email
 */
function initializePasswordRecovery() {
  const loginOverlay = document.getElementById('login-overlay');
  const resetOverlay = document.getElementById('password-reset-overlay');
  const forgotPasswordLink = document.getElementById('forgot-password-link');

  const forgotPasswordForm = document.getElementById('forgot-password-form');
  const resetPasswordForm = document.getElementById('reset-password-form');

  const backToLoginBtn = document.querySelector('.back-to-login-btn');
  const resetTokenInput = document.getElementById('reset-token-input');

  // --- Обробники подій ---

  // Клік на "Не пам'ятаєте пароль?"
  if (forgotPasswordLink) {
    forgotPasswordLink.addEventListener('click', (e) => {
      e.preventDefault();
      loginOverlay.style.display = 'none';
      resetOverlay.style.display = 'flex';
      forgotPasswordForm.style.display = 'block';
      resetPasswordForm.style.display = 'none';
    });
  }

  // Клік на "Назад до входу"
  if (backToLoginBtn) {
    backToLoginBtn.addEventListener('click', () => {
      resetOverlay.style.display = 'none';
      loginOverlay.style.display = 'flex';
    });
  }

  // Відправка форми запиту на відновлення
  if (forgotPasswordForm) {
    forgotPasswordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('recovery-email').value;
      const statusDivId = 'forgot-password-response';
      displayStatus(statusDivId, 'Відправляємо запит...', false);

      try {
        const response = await fetch(`${baseURL}/forgot-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.detail || 'Сталася помилка.');
        }
        displayStatus(statusDivId, data.message, false);
      } catch (error) {
        displayStatus(statusDivId, `Помилка: ${error.message}`, true);
      }
    });
  }

  // Відправка форми встановлення нового пароля
  if (resetPasswordForm) {
    resetPasswordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = resetTokenInput.value;
      const newPassword = document.getElementById('reset-new-password').value;
      const confirmPassword = document.getElementById(
        'reset-confirm-password'
      ).value;
      const statusDivId = 'reset-password-response';

      if (newPassword.length < 8) {
        displayStatus(
          statusDivId,
          'Новий пароль має містити щонайменше 8 символів.',
          true,
          4000
        );
        return;
      }
      if (newPassword !== confirmPassword) {
        displayStatus(statusDivId, 'Паролі не співпадають.', true, 4000);
        return;
      }

      displayStatus(statusDivId, 'Збереження нового паролю...', false);

      try {
        const response = await fetch(`${baseURL}/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token, new_password: newPassword }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.detail || 'Не вдалося оновити пароль.');
        }

        alert(
          'Пароль успішно змінено! Тепер ви можете увійти з новим паролем.'
        );
        resetOverlay.style.display = 'none';
        loginOverlay.style.display = 'flex';
        // Очищуємо URL від токена
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname
        );
      } catch (error) {
        displayStatus(statusDivId, `Помилка: ${error.message}`, true);
      }
    });
  }

  // --- Логіка при завантаженні сторінки ---
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');

  if (token) {
    console.log('Знайдено токен відновлення пароля:', token);
    loginOverlay.style.display = 'none';
    resetOverlay.style.display = 'flex';
    forgotPasswordForm.style.display = 'none';
    resetPasswordForm.style.display = 'block';
    resetTokenInput.value = token;
  }
}

/**
 * ОНОВЛЕНО v6: Головна функція-оркестратор з перевіркою статусу генерації.
 */
async function runInitialChecksAndModals() {
  if (!isAuthorized()) return;

  let attempts = 0;
  const maxAttempts = 10;
  const checkInterval = 500;

  const performChecks = async () => {
    const daySelectorOverlay = document.getElementById(
      'day-selector-modal-overlay'
    );
    const newPlanOverlay = document.getElementById(
      'new-plan-notification-overlay'
    );

    if (daySelectorOverlay && newPlanOverlay) {
      try {
        const [
          { data: profileData, response: profileResponse },
          { data: plansData, response: plansResponse },
          { data: subscriptionsData, response: subResponse },
        ] = await Promise.all([
          fetchWithAuth(`${baseURL}/profile/my-profile`),
          fetchWithAuth(`${baseURL}/my-workout-plans`),
          fetchWithAuth(`${baseURL}/api/my-subscriptions`),
        ]);

        if (!profileResponse.ok) return;

        const now = new Date();
        const hasActiveSub =
          subResponse.ok &&
          Array.isArray(subscriptionsData) &&
          subscriptionsData.some(
            (sub) => sub.status === 'active' && new Date(sub.end_date) > now
          );

        currentUserProfileData = profileData;

        if (profileData && profileData.registration_type === 'self') {
          const plans = plansData || [];

          // Модальне вікно №2: Повідомлення про новий 30-денний план
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          const newestPlan = plans.sort(
            (a, b) => new Date(b.created_at) - new Date(a.created_at)
          )[0];

          if (
            newestPlan &&
            new Date(newestPlan.created_at) > thirtyDaysAgo &&
            !localStorage.getItem(`plan_notified_${newestPlan.id}`)
          ) {
            const oldestPlan = plans.sort(
              (a, b) => new Date(a.created_at) - new Date(b.created_at)
            )[0];
            if (newestPlan.id !== oldestPlan.id) {
              await showNewPlanNotificationModal();
              localStorage.setItem(`plan_notified_${newestPlan.id}`, 'true');
            }
          }

          // Модальне вікно №1: Вибір днів тижня для тренувань
          let planToSchedule = plans.find((p) => !p.are_workouts_generated);

          // Перевіряємо, чи потрібно взагалі показувати вікно
          if (planToSchedule) {
            // 1. Перевіряємо, чи користувач ВЖЕ обрав дні (у профілі є дані)
            const hasAlreadySelectedDays =
              Array.isArray(profileData.preferred_training_weekdays) &&
              profileData.preferred_training_weekdays.length > 0;

            // 2. Перевіряємо, чи генерація не запущена (на випадок оновлення сторінки)
            const generationTimestamp = localStorage.getItem(
              `generation_in_progress_${planToSchedule.id}`
            );
            const tenMinutes = 10 * 60 * 1000;
            const isGenerationInProgress =
              generationTimestamp &&
              Date.now() - generationTimestamp < tenMinutes;

            // Якщо дні вже обрані АБО генерація вже йде, не показуємо вікно
            if (hasAlreadySelectedDays || isGenerationInProgress) {
              planToSchedule = null;
            }
          }

          // Показуємо вікно вибору днів ТІЛЬКИ якщо є активна підписка і є план для генерації
          if (hasActiveSub && planToSchedule) {
            await showDaySelectorModal(planToSchedule, profileData);
          }
        }

        // Модальне вікно №3: Нагадування про закінчення підписки (ДЛЯ ВСІХ)
        await checkAndShowSubscriptionReminder();
      } catch (error) {
        console.error('Помилка під час початкових перевірок:', error);
      }
    } else {
      attempts++;
      if (attempts < maxAttempts) {
        setTimeout(performChecks, checkInterval);
      } else {
        console.error(
          'Не вдалося знайти HTML-елементи для модальних вікон після кількох спроб.'
        );
      }
    }
  };

  performChecks();
}

/**
 * ОНОВЛЕНО v5: Запускає логіку вже ПІСЛЯ підготовки вкладок.
 */
async function runAuthenticatedCabinet() {
  // updatePlanTabVisibility() вже було викликано в startApp.
  // Тому ми можемо безпечно показати вже підготовлений інтерфейс.
  updateVisibility();

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('login')) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    setTimeout(() => window.scrollTo({ top: 0, behavior: 'auto' }), 50);
    setTimeout(() => window.scrollTo({ top: 0, behavior: 'auto' }), 150);
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const hash = window.location.hash.substring(1);

  // Перевіряємо підписку, отримуємо її статус і використовуємо його далі
  const shouldForceRedirect = hash !== 'plan';
  const hasActiveSub =
    await checkInitialSubscriptionAndRedirect(shouldForceRedirect);

  // Відкриваємо потрібну вкладку ПІСЛЯ перевірки
  if (hash === 'plan') {
    const planTabButton = document.querySelector(
      '.tab-link[data-tab-name="plan"]'
    );
    if (planTabButton && !planTabButton.classList.contains('active')) {
      openTab({ currentTarget: planTabButton }, 'plan');
    }
  }

  await runInitialChecksAndModals();

  // Запускаємо передзавантаження GIF тільки якщо є активна підписка
  if (hasActiveSub) {
    preloadFirstActiveWorkoutGif();
  }
  scheduleProactiveTokenRefresh();
  fetchAndDisplayUnreadCount();
}

/**
 * ОНОВЛЕНО: Готує стан вкладок ДО показу кабінету, щоб уникнути "миготіння".
 */
function startApp() {
  initializePasswordRecovery();

  let attempts = 0;
  const maxAttempts = 5;
  const intervalMs = 200;

  const authCheckInterval = setInterval(async () => {
    // Робимо колбек асинхронним
    attempts++;

    if (isAuthorized()) {
      clearInterval(authCheckInterval);

      // 1. Спочатку готуємо стан вкладок (ховаємо/показуємо "План")
      await updatePlanTabVisibility();

      // 2. Тепер, коли UI готовий, запускаємо основну логіку,
      //    яка зробить кабінет видимим.
      runAuthenticatedCabinet();
    } else if (attempts >= maxAttempts) {
      clearInterval(authCheckInterval);
      updateVisibility(); // Показуємо форму входу, якщо авторизація не вдалась
    }
  }, intervalMs);

  // --- Решта коду функції залишається без змін ---
  const textareas = document.querySelectorAll('.auto-resize-textarea');
  textareas.forEach((textarea) => {
    textarea.addEventListener('input', () => autoResize(textarea));
    autoResize(textarea);
  });

  document.body.addEventListener('click', function (event) {
    if (event.target.id === 'show-independent-workout-form-btn') {
      showUserWorkoutForm();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      console.log('Вкладка стала видимою.');
      if (isAuthorized()) {
        const expiresAt = getAccessTokenExpiresAt();
        const now = new Date().getTime();
        if (
          expiresAt &&
          expiresAt - now < PROACTIVE_REFRESH_LEAD_TIME_MS * 1.5
        ) {
          handleProactiveTokenRefresh();
        } else if (expiresAt) {
          scheduleProactiveTokenRefresh();
        }
      }
      unlockAudioContext();
      const pollingPlanId = document.body.dataset.pollingPlanId;
      if (pollingPlanId) {
        checkForAnalysisResult(pollingPlanId);
      }
    } else {
      console.log('Вкладка стала невидимою.');
    }
  });
}

/**
 * САМОЗАПУСКНИЙ МЕХАНІЗМ:
 * Цей код не покладається на DOMContentLoaded. Він сам перевіряє, чи готова сторінка.
 */
(function waitForDOM() {
  // Перевіряємо наявність ключових елементів, які точно є на сторінці
  if (
    document.getElementById('cabinet') &&
    document.getElementById('login-overlay')
  ) {
    startApp(); // Запускаємо нашу основну логіку
  } else {
    // Якщо елементів ще немає, пробуємо знову через 100 мс
    setTimeout(waitForDOM, 100);
  }
})();

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
