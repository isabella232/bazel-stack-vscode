// Original file: proto/bzl.proto

import { Workspace as _build_stack_bezel_v1beta1_Workspace, Workspace__Output as _build_stack_bezel_v1beta1_Workspace__Output } from '../../../../build/stack/bezel/v1beta1/Workspace';
import { FileKind as _build_stack_bezel_v1beta1_FileKind } from '../../../../build/stack/bezel/v1beta1/FileKind';

export interface FileDownloadRequest {
  'workspace'?: (_build_stack_bezel_v1beta1_Workspace);
  /**
   * The kind of the file
   */
  'kind'?: (_build_stack_bezel_v1beta1_FileKind | keyof typeof _build_stack_bezel_v1beta1_FileKind);
  /**
   * Bazel label to retrieve
   */
  'label'?: (string);
}

export interface FileDownloadRequest__Output {
  'workspace'?: (_build_stack_bezel_v1beta1_Workspace__Output);
  /**
   * The kind of the file
   */
  'kind': (_build_stack_bezel_v1beta1_FileKind);
  /**
   * Bazel label to retrieve
   */
  'label': (string);
}