-- KhetPatch Row-Level Security Policies (Supabase PostgreSQL)

ALTER TABLE farms ENABLE ROW LEVEL SECURITY;
ALTER TABLE fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

-- Farmers can read/insert/update/delete only their own farms
CREATE POLICY farms_owner_select ON farms
  FOR SELECT USING (
    owner_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = farms.organization_id
        AND ur.role IN ('AGRONOMIST', 'FPO_MANAGER', 'ORGANIZATION_ADMIN')
    )
  );

CREATE POLICY farms_owner_insert ON farms
  FOR INSERT WITH CHECK (owner_user_id = auth.uid());

CREATE POLICY farms_owner_update ON farms
  FOR UPDATE USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- Fields strictly inherit tenant & ownership isolation
CREATE POLICY fields_access_select ON fields
  FOR SELECT USING (
    owner_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM farms f
      JOIN user_roles ur ON ur.organization_id = f.organization_id
      WHERE f.id = fields.farm_id
        AND ur.user_id = auth.uid()
        AND ur.role IN ('AGRONOMIST', 'FPO_MANAGER', 'ORGANIZATION_ADMIN')
    )
  );

CREATE POLICY fields_owner_write ON fields
  FOR ALL USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- Users can view only their own role assignments; only Org Admin (within org) can manage org roles
CREATE POLICY user_roles_self_select ON user_roles
  FOR SELECT USING (user_id = auth.uid());
