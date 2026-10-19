export interface Ref {
  id: string;
  name: string;
  nameAr?: string | null;
}

export interface Employee {
  id: string;
  companyId: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  firstNameAr: string | null;
  lastNameAr: string | null;
  email: string;
  personalEmail: string | null;
  phone: string | null;
  gender: 'MALE' | 'FEMALE' | null;
  dateOfBirth: string | null;
  nationality: string | null;
  maritalStatus: string | null;
  nationalIdType: 'EMIRATES_ID' | 'PASSPORT' | 'OTHER' | null;
  nationalId: string | null;
  pensionScheme: 'NONE' | 'GPSSA_OLD' | 'GPSSA_NEW' | 'ADPF_OLD' | 'ADPF_NEW';
  /** null = inherited from the job grade */
  overtimeEligible: boolean | null;
  address: string | null;
  emergencyContact: { name: string; relation?: string; phone: string } | null;
  photoPath: string | null;
  branchId: string | null;
  departmentId: string | null;
  positionId: string | null;
  gradeId: string | null;
  categoryId: string | null;
  employmentTypeId: string | null;
  costCenterId: string | null;
  managerId: string | null;
  shiftId: string | null;
  hireDate: string;
  probationEndDate: string | null;
  contractStartDate: string | null;
  contractEndDate: string | null;
  status: 'PROBATION' | 'ACTIVE' | 'SUSPENDED' | 'RESIGNED' | 'TERMINATED' | 'RETIRED';
  separationDate: string | null;
  separationReason: string | null;
  bankName: string | null;
  bankAccount: string | null;
  iban: string | null;
  canViewSensitive: boolean;
  company?: { id: string; name: string; nameAr: string | null; baseCurrency: string };
  branch?: Ref | null;
  department?: Ref | null;
  position?: { id: string; title: string; titleAr: string | null } | null;
  grade?: { id: string; code: string; name: string; overtimeEligible: boolean } | null;
  category?: Ref | null;
  employmentType?: Ref | null;
  costCenter?: { id: string; code: string; name: string } | null;
  manager?: { id: string; employeeNo: string; firstName: string; lastName: string; firstNameAr: string | null; lastNameAr: string | null } | null;
  shift?: { id: string; name: string; startTime: string; endTime: string } | null;
  user?: { id: string; email: string; isActive: boolean; lastLoginAt: string | null; roles: { role: { code: string; name: string } }[] } | null;
  _count?: { reports: number; documents: number };
  temporaryPassword?: string;
  /** Non-blocking checks returned after saving (e.g. manager in another department). */
  warnings?: { code: string; field: string; message: string }[];
}

export interface ApprovalRequest {
  id: string;
  requestType: string;
  entityId: string;
  title: string;
  status: string;
  currentStep: number;
  amount: string | null;
  summary: Record<string, unknown> | null;
  createdAt: string;
  completedAt: string | null;
  requester: { id: string; displayName: string };
  employee: { id: string; employeeNo: string; firstName: string; lastName: string; firstNameAr: string | null; lastNameAr: string | null } | null;
}

export const EMPLOYEE_STATUSES = ['PROBATION', 'ACTIVE', 'SUSPENDED', 'RESIGNED', 'TERMINATED', 'RETIRED'] as const;
