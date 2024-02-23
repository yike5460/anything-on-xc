import { NestedStack, StackProps, Duration, Aws, RemovalPolicy, Expiration } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import * as path from 'path';
import * as fs from 'fs';

interface ec2StackProps extends StackProps {
    ec2InstanceType: string;
}

export class EC2Stack extends NestedStack {

    _s3Name;
    _instanceId;
    _albAddress;
    _launchTemplateId;
    constructor(scope: Construct, id: string, props: ec2StackProps) {
        super(scope, id, props);

        // Lookup for default VPC
        const _defaultVpc = ec2.Vpc.fromLookup(this, 'default-vpc', {
            isDefault: true,
        });

        // S3 bucket to store models
        const _modelsBucket = new s3.Bucket(this, 'sd-models', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // Deploy models to S3 bucket
        new s3deploy.BucketDeployment(this, 'DeployModels', {
            sources: [s3deploy.Source.asset('lib/models')],
            destinationBucket: _modelsBucket,
        });

        // Security group for EC2 instance
        const _ec2SecurityGroup = new ec2.SecurityGroup(this, 'sd-ec2-sg', {
            vpc: ec2.Vpc.fromLookup(this, 'default', {
                isDefault: true,
            }),
            allowAllOutbound: true,
        });

        // Allow ssh, webui port from anywhere
        _ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'allow ssh access from anywhere');
        _ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(7860), 'allow webui access from anywhere');

        // Create instance role to connect to S3 bucket through storage file gateway
        const _instanceRole = new iam.Role(this, 'sd-ec2-role', {
            // Fix this name since we need to concatenate in user_data.sh
            roleName: 'sd-ec2-role',
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        });

        // Allow EC2 instance to connect to S3 bucket
        _instanceRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            // Full S3 access for s3fs connection
            actions: [
                's3:*',
            ],
            resources: [
                _modelsBucket.bucketArn,
                _modelsBucket.arnForObjects('*'),
            ],
        }));

        // Allow EC2 instance to connect to SSM with full access for PVRE consideration
        _instanceRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMFullAccess'));

        // Create EFS file system
        const _efsFileSystem = new efs.FileSystem(this, 'sd-efs', {
            vpc: _defaultVpc,
            lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
            performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
            throughputMode: efs.ThroughputMode.BURSTING,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        // TODO, remove the dep install part in user_data.sh and pack all the dependencies into a new AMI to save cloud-init time (5+ mins for model download, SD setup, etc.)
        // Read the user data script into a string, replacing the bucket name placeholder
        let user_data = fs.readFileSync(path.join(__dirname, 'user_data.sh'), 'utf8')
                        .replace('${BUCKET_NAME}', _modelsBucket.bucketName);

        // Replace the file system ID placeholder
        user_data = user_data.replace('${FS_ID}', _efsFileSystem.fileSystemId);

        // Replace the region placeholder
        user_data = user_data.replace('${REGION}', Aws.REGION);

        // Step 1, use single EC2 instance to setup S3 file gateway and EFS connection, launch webui as service and test the prototype. The user data script will be executed during the first boot cycle of an EC2 instance and is highly customizable depending on the application requirements.
        const _ec2Instance = new ec2.Instance(this, 'sd-ec2-instance', {
            vpc: _defaultVpc,
            role: _instanceRole,
            instanceType: new ec2.InstanceType(props.ec2InstanceType),
            // # aws ec2 describe-images \
            // #     --owners amazon \
            // #     --filters "Name=name,Values=Deep Learning Base OSS Nvidia Driver GPU AMI*" "Name=is-public,Values=true" "Name=state,Values=available" \
            // #     --query "Images[*].[ImageId,Name,Description]" \
            // #     --region us-east-1 \
            // #     --output json | jq -r 'sort_by(.[1] | capture(".* (?<date>[0-9]+)$").date | strptime("%Y%m%d") | mktime) | .[-1][0]'
            machineImage: ec2.MachineImage.genericLinux({
                'us-east-1': 'ami-0da2ab58cace8997d',
            }),
            // Set Volume size to 300 GB to fulfill the SD requirement 
            blockDevices: [{
                deviceName: '/dev/sda1',
                volume: ec2.BlockDeviceVolume.ebs(300),
            }],
            keyPair: ec2.KeyPair.fromKeyPairName(this, 'KeyPair', 'us-east-1'),
            securityGroup: _ec2SecurityGroup,
            // userData: ec2.UserData.forLinux({
            //     shebang: '#!/bin/bash -xe' + '\n' + 'echo "Hello World"',
            // }),
            // The userdata will not be executed for CDK update even the instance been terminated and re-create, try to delete the stack and re-deploy it
            // Also note user data scripts and cloud-init directives only run during the first boot cycle of an EC2 instance by default
            userData: ec2.UserData.custom(user_data),
        });

        // Allow EC2 instance to connect to EFS file system
        _efsFileSystem.connections.allowDefaultPortFrom(_ec2Instance);

        // Stage 2, use application load balancer + auto scaling group to implement the webui cluster once the prototype is ready in step 1, and remove the single EC2 instance in step 1
        const lb = new elbv2.ApplicationLoadBalancer(this, 'LB', {
            vpc: _defaultVpc,
            internetFacing: true,
        });

        // Listener for load balancer on port 7860 (WebUI)
        const listener = lb.addListener('WebUI', {
            port: 7860,
            protocol: elbv2.ApplicationProtocol.HTTP,
        });

        // Spot instance for cost saving
        const launchTemplateSpotOptions: ec2.LaunchTemplateSpotOptions = {
            // blockDuration: Duration.minutes(60),
            interruptionBehavior: ec2.SpotInstanceInterruption.STOP,
            // Maximum hourly price will default to the on-demand price for the instance type.
            // maxPrice: 1,
            requestType: ec2.SpotRequestType.PERSISTENT,
            validUntil: Expiration.after(Duration.days(7)),
        };
        
        // Launch template for auto scaling group with mixed instances policy (on-demand + spot)
        const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
            // TODO: prototype needed. If you create an ASG with a launch template that has spotOptions defined but without a mixed instances policy, the ASG will only launch spot instances, not a mix of on-demand and spot instances.

            // LONG NOTE ALERT: Now we use mixedInstancesPolicy to handle the spot instance request based on parameters like onDemandBaseCapacity, onDemandPercentageAboveBaseCapacity, and spotAllocationStrategy. In a mixed instances policy for an Auto Scaling group, we do not set interruptionBehavior, maxPrice, or requestType directly in the launch template because the Auto Scaling group manages the procurement of Spot Instances for us. Instead, we configure the policy to determine how Spot Instances are requested and maintained within the group as follows:

            // Interruption Behavior: AWS Auto Scaling groups with a mixed instances policy do not directly expose an interruptionBehavior setting. However, you can achieve a similar result by enabling Capacity Rebalancing for your Auto Scaling group, which helps replace Spot Instances that AWS is about to reclaim due to price or capacity.

            // Max Price: When you use a mixed instances policy, we can use spotPrice to specify a maximum price for Spot Instances. The Spot Instances are launched based on the spotAllocationStrategy and will not exceed the On-Demand price unless you specify otherwise.

            // Request Type: The requestType for Spot Instances is managed by the Auto Scaling group when using a mixed instances policy. The Auto Scaling group will automatically manage the requests and maintain the target capacity.

            // spotOptions: launchTemplateSpotOptions,
            instanceType: new ec2.InstanceType(props.ec2InstanceType),
            machineImage: ec2.MachineImage.genericLinux({
                'us-east-1': 'ami-0da2ab58cace8997d',
            }),
            blockDevices: [{
                deviceName: '/dev/sda1',
                volume: autoscaling.BlockDeviceVolume.ebs(300),
            }],
            keyPair: ec2.KeyPair.fromKeyPairName(this, 'KeyPairASG', 'us-east-1'),
            securityGroup: _ec2SecurityGroup,
            userData: ec2.UserData.custom(user_data),
            role: _instanceRole,
        });

        // Auto Scaling Group
        const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
            vpc: _defaultVpc,
            // instanceType: new ec2.InstanceType(props.ec2InstanceType),
            // machineImage: ec2.MachineImage.genericLinux({
            //     'us-east-1': 'ami-0da2ab58cace8997d',
            // }),
            // blockDevices: [{
            //     deviceName: '/dev/sda1',
            //     volume: autoscaling.BlockDeviceVolume.ebs(300),
            // }],
            // keyName: 'us-east-1',
            // securityGroup: _ec2SecurityGroup,
            // userData: ec2.UserData.custom(user_data),

            // TODO, (1) consider to use mixedInstancesPolicy to combine on-demand and spot instances and note such policy is not supported for launch template with spotOptions; (2) consider the spot instance interruption behavior using Capacity Rebalancing; (3) consider to use lifecycle hook to pull system or application logs and upload them S3 before the instance is terminated, refer to https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-capacity-rebalancing.html
            maxCapacity: 5,
            // Make sure at least 1 spot instance is running
            minCapacity: 2,
            // setting a spotPrice within a mixed instances policy can be a double-edged sword. On one hand, it can help control costs by ensuring that 23 never pay more for Spot Instances than you're willing to. On the other hand, it may reduce the availability of Spot Instances if our maximum price is often below the going Spot rate, potentially leading to a higher proportion of On-Demand Instances being used.
            // spotPrice: '0.05',
            // launchTemplate: launchTemplate,
            mixedInstancesPolicy: {
                instancesDistribution: {
                    // number of on-demand instances to keep in the auto scaling group
                    onDemandBaseCapacity: 1,
                    // percentage of on-demand instances above the base capacity
                    onDemandPercentageAboveBaseCapacity: 50,
                    spotAllocationStrategy: autoscaling.SpotAllocationStrategy.PRICE_CAPACITY_OPTIMIZED,
                },
                launchTemplate: launchTemplate,
            },
            capacityRebalance: true,
        });

        // Add auto scaling group to load balancer
        listener.addTargets('Target', {
            port: 7860,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targets: [asg],
        });

        // Enable auto scaling based on CPU utilization for now, TODO: update to GPU utilization
        asg.scaleOnCpuUtilization('CpuScaling', {
            targetUtilizationPercent: 60,
        });

        this._s3Name = _modelsBucket.bucketName;
        this._instanceId = _ec2Instance.instanceId;
        this._albAddress = lb.loadBalancerDnsName;
        this._launchTemplateId = launchTemplate.launchTemplateId;
    }
}