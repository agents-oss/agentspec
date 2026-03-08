{{/*
Expand the name of the chart.
*/}}
{{- define "agentspec-operator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agentspec-operator.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: {{ include "agentspec-operator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: operator
agentspec.io/role: operator
{{- end }}

{{/*
Selector labels (stable subset — never changes after first deploy)
*/}}
{{- define "agentspec-operator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentspec-operator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "agentspec-operator.serviceAccountName" -}}
{{- if .Values.rbac.create }}
{{- .Values.rbac.serviceAccountName | default "agentspec-operator" }}
{{- else }}
{{- "default" }}
{{- end }}
{{- end }}

{{/*
Operator image (repo:tag, defaults to Chart.appVersion)
*/}}
{{- define "agentspec-operator.image" -}}
{{ .Values.operator.image.repository }}:{{ .Values.operator.image.tag | default .Chart.AppVersion }}
{{- end }}

{{/*
Control plane labels
*/}}
{{- define "agentspec-operator.controlPlaneLabels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: {{ include "agentspec-operator.name" . }}-control-plane
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: control-plane
agentspec.io/role: control-plane
{{- end }}

{{/*
Control plane selector labels (stable subset)
*/}}
{{- define "agentspec-operator.controlPlaneSelectorLabels" -}}
app.kubernetes.io/name: {{ include "agentspec-operator.name" . }}-control-plane
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Control plane image (repo:tag)
*/}}
{{- define "agentspec-operator.controlPlaneImage" -}}
{{ .Values.controlPlane.image.repository }}:{{ .Values.controlPlane.image.tag | default .Chart.AppVersion }}
{{- end }}

{{/*
Control plane internal service URL (auto-resolved when controlPlane.url is empty)
*/}}
{{- define "agentspec-operator.controlPlaneUrl" -}}
{{- if .Values.controlPlane.url -}}
{{ .Values.controlPlane.url }}
{{- else -}}
http://{{ include "agentspec-operator.name" . }}-control-plane.{{ .Release.Namespace }}.svc.cluster.local
{{- end -}}
{{- end }}
