import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Validate connection to Firestore on boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

// Blueprint-synchronized sanitization helpers (exact maxLength & pattern parity with firebase-blueprint.json)
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function assertValidBlueprintId(value: string, label: string): string {
  const cleaned = value.trim().slice(0, 128);
  if (!cleaned || !ID_PATTERN.test(cleaned)) {
    throw new Error(`Invalid ${label} identifier format.`);
  }
  return cleaned;
}

function clampString(value: string, maxLength: number, fallback = 'N/A'): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback.slice(0, maxLength);
  return trimmed.slice(0, maxLength);
}

export async function signInWithGooglePopup(): Promise<{ idToken: string; user: FirebaseUser }> {
  const credential = await signInWithPopup(auth, googleProvider);
  const idToken = await credential.user.getIdToken();
  return { idToken, user: credential.user };
}

export async function signOutFirebase(): Promise<void> {
  await firebaseSignOut(auth).catch(() => {});
}

export function subscribeFirebaseAuth(cb: (user: FirebaseUser | null) => void): Unsubscribe {
  return onAuthStateChanged(auth, cb);
}

export async function syncFirebaseUserProfile(
  fbUser: FirebaseUser,
  preferredLanguage: 'en' | 'hi' | 'mr' = 'en'
): Promise<void> {
  if (!fbUser.emailVerified) return;
  const uid = assertValidBlueprintId(fbUser.uid, 'uid');
  const displayName = clampString(fbUser.displayName || 'KhetPatch Farmer', 120, 'KhetPatch Farmer');
  const email = clampString(fbUser.email || '', 200);

  const userPath = `users/${uid}`;
  try {
    const ref = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        uid,
        displayName,
        role: 'FARMER',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        displayName,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }

  if (email) {
    const privatePath = `users/${uid}/private/info`;
    try {
      const privRef = doc(db, 'users', uid, 'private', 'info');
      const privSnap = await getDoc(privRef);
      if (!privSnap.exists()) {
        await setDoc(privRef, {
          uid,
          email,
          preferredLanguage,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(privRef, {
          preferredLanguage,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, privatePath);
    }
  }
}

export async function syncFarmRecordToFirestore(farm: {
  id: string;
  name: string;
  village: string;
  district: string;
  state: string;
  latitude: number;
  longitude: number;
  agroclimaticZone: string;
  totalAreaAcres: number;
  waterAvailability: 'Rainfed' | 'Limited' | 'Irrigated';
}): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser || !currentUser.emailVerified) return;

  const ownerId = assertValidBlueprintId(currentUser.uid, 'ownerId');
  const farmId = assertValidBlueprintId(farm.id, 'farmId');
  const path = `farms/${farmId}`;

  try {
    const farmRef = doc(db, 'farms', farmId);
    const snap = await getDoc(farmRef);
    const baseData = {
      name: clampString(farm.name, 160),
      village: clampString(farm.village, 120),
      district: clampString(farm.district, 120),
      state: clampString(farm.state, 120),
      latitude: Math.max(-90, Math.min(90, Number(farm.latitude))),
      longitude: Math.max(-180, Math.min(180, Number(farm.longitude))),
      agroclimaticZone: clampString(farm.agroclimaticZone, 200),
      totalAreaAcres: Math.max(0.01, Math.min(100000, Number(farm.totalAreaAcres))),
      waterAvailability: farm.waterAvailability,
      updatedAt: serverTimestamp(),
    };

    if (!snap.exists()) {
      await setDoc(farmRef, {
        id: farmId,
        ownerId,
        ...baseData,
        status: 'ACTIVE',
        createdAt: serverTimestamp(),
      });
    } else if (snap.data()?.ownerId === ownerId) {
      await updateDoc(farmRef, baseData);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncFieldRecordToFirestore(field: {
  id: string;
  farmId: string;
  name: string;
  areaAcres: number;
  soilType?: string | null;
  currentCrop?: string | null;
  previousCrop?: string | null;
  waterAvailability: 'Rainfed' | 'Limited' | 'Irrigated';
  centroidLat: number;
  centroidLon: number;
}): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser || !currentUser.emailVerified) return;

  const ownerId = assertValidBlueprintId(currentUser.uid, 'ownerId');
  const farmId = assertValidBlueprintId(field.farmId, 'farmId');
  const fieldId = assertValidBlueprintId(field.id, 'fieldId');
  const path = `farms/${farmId}/fields/${fieldId}`;

  try {
    const fieldRef = doc(db, 'farms', farmId, 'fields', fieldId);
    const snap = await getDoc(fieldRef);
    const baseData: Record<string, unknown> = {
      name: clampString(field.name, 160),
      areaAcres: Math.max(0.01, Math.min(50000, Number(field.areaAcres))),
      waterAvailability: field.waterAvailability,
      centroidLat: Math.max(-90, Math.min(90, Number(field.centroidLat))),
      centroidLon: Math.max(-180, Math.min(180, Number(field.centroidLon))),
      updatedAt: serverTimestamp(),
    };
    if (field.soilType) baseData.soilType = clampString(field.soilType, 100);
    if (field.currentCrop) baseData.currentCrop = clampString(field.currentCrop, 100);
    if (field.previousCrop) baseData.previousCrop = clampString(field.previousCrop, 100);

    if (!snap.exists()) {
      await setDoc(fieldRef, {
        id: fieldId,
        farmId,
        ownerId,
        ...baseData,
        createdAt: serverTimestamp(),
      });
    } else if (snap.data()?.ownerId === ownerId) {
      await updateDoc(fieldRef, baseData);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncRotationPlanToFirestore(plan: {
  id: string;
  farmId: string;
  fieldId: string;
  planningSeason: string;
  selectedStrategyType: 'EXISTING' | 'MINIMAL_CHANGE' | 'ALTERNATIVE';
  selectedCrop: string;
  status: 'DRAFT' | 'APPROVED' | 'COMPLETED' | 'ARCHIVED';
  summaryNote?: string | null;
}): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser || !currentUser.emailVerified) return;

  const ownerId = assertValidBlueprintId(currentUser.uid, 'ownerId');
  const farmId = assertValidBlueprintId(plan.farmId, 'farmId');
  const fieldId = assertValidBlueprintId(plan.fieldId, 'fieldId');
  const planId = assertValidBlueprintId(plan.id, 'planId');
  const path = `farms/${farmId}/rotationPlans/${planId}`;
  const validSeason = (['Kharif', 'Rabi', 'Zaid'].includes(plan.planningSeason)
    ? plan.planningSeason
    : 'Rabi') as 'Kharif' | 'Rabi' | 'Zaid';

  try {
    const fieldSnap = await getDoc(doc(db, 'farms', farmId, 'fields', fieldId));
    if (!fieldSnap.exists()) return;

    const planRef = doc(db, 'farms', farmId, 'rotationPlans', planId);
    const snap = await getDoc(planRef);
    const summaryNote = plan.summaryNote ? clampString(plan.summaryNote, 500) : undefined;

    if (!snap.exists()) {
      const createStatus = plan.status === 'DRAFT' || plan.status === 'APPROVED' ? plan.status : 'APPROVED';
      const payload: Record<string, unknown> = {
        id: planId,
        farmId,
        fieldId,
        ownerId,
        planningSeason: validSeason,
        selectedStrategyType: plan.selectedStrategyType,
        selectedCrop: clampString(plan.selectedCrop, 120),
        status: createStatus,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (summaryNote) payload.summaryNote = summaryNote;
      await setDoc(planRef, payload);
    } else if (
      snap.data()?.ownerId === ownerId &&
      snap.data()?.status !== 'COMPLETED' &&
      snap.data()?.status !== 'ARCHIVED'
    ) {
      const updatePayload: Record<string, unknown> = {
        selectedStrategyType: plan.selectedStrategyType,
        selectedCrop: clampString(plan.selectedCrop, 120),
        status: plan.status === 'DRAFT' ? 'APPROVED' : plan.status,
        updatedAt: serverTimestamp(),
      };
      if (summaryNote) updatePayload.summaryNote = summaryNote;
      await updateDoc(planRef, updatePayload);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncTaskToFirestore(task: {
  id: string;
  farmId: string;
  fieldId: string;
  title: string;
  category: string;
  dueDate: string;
  priority: string;
  status: string;
  farmerFeedback?: string | null;
}): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser || !currentUser.emailVerified) return;

  const ownerId = assertValidBlueprintId(currentUser.uid, 'ownerId');
  const farmId = assertValidBlueprintId(task.farmId, 'farmId');
  const fieldId = assertValidBlueprintId(task.fieldId, 'fieldId');
  const taskId = assertValidBlueprintId(task.id, 'taskId');
  const path = `farms/${farmId}/tasks/${taskId}`;

  const priority = (['High', 'Medium', 'Low'].includes(task.priority)
    ? task.priority
    : 'Medium') as 'High' | 'Medium' | 'Low';
  const clampedStatus = (['UPCOMING', 'POSTPONED', 'COMPLETED'].includes(task.status)
    ? task.status
    : 'UPCOMING') as 'UPCOMING' | 'POSTPONED' | 'COMPLETED';
  const cleanDueDate = clampString(task.dueDate.length >= 10 ? task.dueDate : `${task.dueDate}T00:00:00`, 32);

  try {
    const fieldSnap = await getDoc(doc(db, 'farms', farmId, 'fields', fieldId));
    if (!fieldSnap.exists()) return;

    const taskRef = doc(db, 'farms', farmId, 'tasks', taskId);
    const snap = await getDoc(taskRef);
    const feedback = task.farmerFeedback ? clampString(task.farmerFeedback, 500) : undefined;

    if (!snap.exists()) {
      const createPayload: Record<string, unknown> = {
        id: taskId,
        farmId,
        fieldId,
        ownerId,
        title: clampString(task.title, 200),
        category: clampString(task.category, 80),
        dueDate: cleanDueDate,
        priority,
        status: 'UPCOMING',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (feedback) createPayload.farmerFeedback = feedback;
      await setDoc(taskRef, createPayload);
    } else if (snap.data()?.ownerId === ownerId && snap.data()?.status !== 'COMPLETED') {
      if (clampedStatus === 'POSTPONED') {
        await updateDoc(taskRef, {
          status: 'POSTPONED',
          dueDate: cleanDueDate,
          farmerFeedback: feedback || 'Postponed',
          updatedAt: serverTimestamp(),
        });
      } else if (clampedStatus === 'COMPLETED') {
        await updateDoc(taskRef, {
          status: 'COMPLETED',
          farmerFeedback: feedback || 'Completed',
          updatedAt: serverTimestamp(),
        });
      } else if (feedback) {
        await updateDoc(taskRef, {
          farmerFeedback: feedback,
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeUserPrivateProfile(
  uid: string,
  onData: (data: Record<string, unknown> | null) => void
): Unsubscribe {
  const cleanUid = assertValidBlueprintId(uid, 'uid');
  const path = `users/${cleanUid}/private/info`;
  return onSnapshot(
    doc(db, 'users', cleanUid, 'private', 'info'),
    (snap) => {
      onData(snap.exists() ? snap.data() : null);
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

